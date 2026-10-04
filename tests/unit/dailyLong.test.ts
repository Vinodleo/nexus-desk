import fs from "fs";
import os from "os";
import path from "path";
import { deflateRawSync, gunzipSync } from "zlib";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketBar } from "../../src/types";
import { appendBars, emptySeries, sumRecords, type CandleSeries } from "../../src/services/historyReplay";
import { seeded } from "../../src/services/setupModel";

// Coins on daily candles back to 2017: each year only that year's 20
// biggest coins, delisted coins read from Binance's archive, replayed in the
// background like the two-year replay.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-daily-long-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const candles = await import("../../server/history/historyCandles");
const long = await import("../../server/history/dailyLong");
const historyJob = await import("../../server/history/historyJob");

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const noPause = async () => {};
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** A zip holding one file, as Binance's archive serves them (deflated, or stored; sizes in the local header or only in the directory). */
function zipOf(name: string, content: string, opts: { stored?: boolean; sizesInDirectoryOnly?: boolean } = {}): Buffer {
  const data = Buffer.from(content);
  const body = opts.stored ? data : deflateRawSync(data);
  const method = opts.stored ? 0 : 8;
  const file = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(opts.sizesInDirectoryOnly ? 8 : 0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(opts.sizesInDirectoryOnly ? 0 : body.length, 18);
  local.writeUInt32LE(opts.sizesInDirectoryOnly ? 0 : data.length, 22);
  local.writeUInt16LE(file.length, 26);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(method, 10);
  dir.writeUInt32LE(body.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(file.length, 28);
  dir.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length + file.length, 12);
  end.writeUInt32LE(local.length + file.length + body.length, 16);
  return Buffer.concat([local, file, body, dir, file, end]);
}

/** Daily kline rows from `from` to before `to`, at `price` (times in microseconds from 2025, as the archive has them). */
function klines(from: number, to: number, price: number, micro = false): string[][] {
  const rows: string[][] = [];
  for (let t = from; t < to; t += DAY) rows.push([String(micro ? t * 1000 : t), `${price}`, `${price * 1.01}`, `${price * 0.99}`, `${price}`, "10", String(t + DAY - 1), "0", "1", "0", "0", "0"]);
  return rows;
}

/**
 * Binance, stubbed. The API lists BTCUSDT (from Aug 2017) and POLUSDT (from
 * 10 Sept 2024); the archive has MATICUSDT (Apr 2019 to 10 Sept 2024),
 * LUNAUSDT (Terra's, then a new coin from Sept 2022) and OLDUSDT (2025, in
 * microseconds, one month stored rather than deflated).
 */
const LISTED = { BTCUSDT: [utc("2017-08-17"), Infinity], POLUSDT: [utc("2024-09-10"), Infinity] } as Record<string, [number, number]>;
const ARCHIVED = {
  MATICUSDT: [utc("2019-04-26"), utc("2024-09-10"), 1],
  LUNAUSDT: [utc("2020-08-21"), utc("2023-12-31"), 50],
  OLDUSDT: [utc("2025-01-01"), utc("2025-03-01"), 2],
} as Record<string, [number, number, number]>;
let archiveCalls = 0;
beforeEach(() => {
  archiveCalls = 0;
  candles._resetHistoryCandles();
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(String(input));
    if (url.host === "data.binance.vision") {
      archiveCalls++;
      const m = url.pathname.match(/\/klines\/([A-Z]+)\/1d\/[A-Z]+-1d-(\d{4})-(\d{2})\.zip$/);
      const a = m && ARCHIVED[m[1]];
      if (!m || !a) return new Response("Not found", { status: 404 });
      const start = Date.UTC(Number(m[2]), Number(m[3]) - 1, 1);
      const end = Date.UTC(Number(m[2]), Number(m[3]), 1);
      const rows = klines(Math.max(start, a[0]), Math.min(end, a[1]), a[2], start >= utc("2025-01-01"));
      if (rows.length === 0) return new Response("Not found", { status: 404 });
      const csv = rows.map((r) => r.join(",")).join("\n") + "\n";
      const stored = m[1] === "OLDUSDT" && m[3] === "02";
      return new Response(zipOf(`${m[1]}-1d-${m[2]}-${m[3]}.csv`, csv, { stored, sizesInDirectoryOnly: m[1] === "MATICUSDT" }));
    }
    const pair = url.searchParams.get("symbol")!;
    const listed = LISTED[pair];
    if (!listed) return new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 });
    const from = Math.max(listed[0], Math.ceil(Number(url.searchParams.get("startTime")) / DAY) * DAY);
    const rows = klines(from, Math.min(Number(url.searchParams.get("endTime")) + 1, from + Number(url.searchParams.get("limit")) * DAY), 100);
    return new Response(JSON.stringify(rows));
  });
});

describe("each year's coins", () => {
  it("are that year's 20 biggest on 1 January; a trade counts only in a year its coin was on the list", () => {
    for (const list of Object.values(long.COIN_COHORTS)) {
      expect(list.length).toBe(20);
      expect(new Set(list).size).toBe(20);
    }
    // After the lists, the last. Before them nothing: 2018's biggest coins were 2017's winners.
    expect(long.cohortFor(2017)).toEqual([]);
    expect(long.inCohort("BTC/INR", utc("2017-12-31"))).toBe(false);
    expect(long.inCohort("BTC/INR", utc("2018-01-01"))).toBe(true);
    expect(long.cohortFor(2026)).toBe(long.COIN_COHORTS[2025]);
    // Terra's LUNA was among the biggest only on 1 January 2022.
    expect(long.inCohort("LUNA/INR", utc("2022-05-09"))).toBe(true);
    expect(long.inCohort("LUNA/INR", utc("2021-12-31"))).toBe(false);
    expect(long.inCohort("LUNA/INR", utc("2023-01-02"))).toBe(false);
    // Solana wasn't big before 2022: today's star isn't replayed in years it was small.
    expect(long.inCohort("SOL/INR", utc("2020-06-01"))).toBe(false);
    expect(long.inCohort("SOL/INR", utc("2022-06-01"))).toBe(true);
    const coins = long.cohortCoins();
    expect(coins[0]).toBe("BTC/INR");
    expect(new Set(coins).size).toBe(coins.length);
    expect(coins).toEqual(expect.arrayContaining(["XMR/INR", "LUNA/INR", "BSV/INR", "MATIC/INR", "PEPE/INR"]));
  });
});

describe("daily candles since 2017", () => {
  it("come from Binance's API page by page, from the coin's first day", async () => {
    const got = await candles.fetchCoinDailySince("BTC/INR", utc("2017-08-01"), utc("2026-10-03"), noPause);
    if ("error" in got) throw new Error(got.error);
    expect(got.series.t[0]).toBe(utc("2017-08-17"));
    expect(got.series.t.at(-1)).toBe(utc("2026-10-02"));
    expect(got.series.t.every((t, k) => k === 0 || t - got.series.t[k - 1] === DAY)).toBe(true);
    expect(archiveCalls).toBe(0);
  });

  it("come from Binance's archive for a pair it no longer lists, in milliseconds whatever the file uses", async () => {
    const got = await candles.fetchCoinDailySince("OLD/INR", utc("2024-11-01"), utc("2026-10-03"), noPause);
    if ("error" in got) throw new Error(got.error);
    expect(got.series.t[0]).toBe(utc("2025-01-01"));
    expect(got.series.t.at(-1)).toBe(utc("2025-02-28"));
    expect(got.series.t.length).toBe(59);
    expect(got.series.c[0]).toBe(2);
    // A month a request, from the first asked for (November 2024) to this one.
    expect(archiveCalls).toBe(24);
  });

  it("follow a coin across the pairs it traded under, and stop Terra's LUNA at its collapse", async () => {
    const matic = await candles.fetchCoinDailySince("MATIC/INR", utc("2017-08-01"), utc("2026-10-03"), noPause);
    if ("error" in matic) throw new Error(matic.error);
    const { t, c } = matic.series;
    expect(t[0]).toBe(utc("2019-04-26"));
    expect(t.every((x, k) => k === 0 || x - t[k - 1] === DAY)).toBe(true);
    // MATIC's archive until the swap, then POL from the API.
    expect(c[t.indexOf(utc("2024-09-09"))]).toBe(1);
    expect(c[t.indexOf(utc("2024-09-10"))]).toBe(100);
    expect(t.at(-1)).toBe(utc("2026-10-02"));

    const luna = await candles.fetchCoinDailySince("LUNA/INR", utc("2017-08-01"), utc("2026-10-03"), noPause);
    if ("error" in luna) throw new Error(luna.error);
    expect(luna.series.t.at(-1)).toBe(utc("2022-05-31"));

    expect(await candles.fetchCoinDailySince("BTG/INR", utc("2024-01-01"), utc("2024-03-01"), noPause)).toEqual({ error: "BTGUSDT isn't on Binance" });
  });
});

/** Daily candles of a lively coin from `fromIso` to `toIso`, wandering upward. */
function dailySeries(fromIso: string, toIso: string, seed: number): CandleSeries {
  const random = seeded(seed);
  let p = 100;
  const bars: MarketBar[] = [];
  for (let t = utc(fromIso); t < utc(toIso); t += DAY) {
    const o = p;
    p *= 1 + 0.002 + (random() - 0.5) * 0.06;
    bars.push({ time: "", timestampMs: t, open: o, high: Math.max(o, p) * 1.02, low: Math.min(o, p) * 0.98, close: p, volume: 1000 + random() * 3000 });
  }
  const s = emptySeries();
  appendBars(s, bars);
  return s;
}

describe("the long daily replay", () => {
  const series: Record<string, CandleSeries> = {
    "BTC/INR": dailySeries("2020-01-01", "2023-06-01", 3),
    "LUNA/INR": dailySeries("2020-08-21", "2022-06-01", 5),
  };
  function fakes(over: Partial<import("../../server/history/dailyLong").DailyLongDeps> = {}) {
    const sleeps: number[] = [];
    const downloads: string[] = [];
    let clock = utc("2026-10-03") + 3_600_000;
    const deps = {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      symbols: () => ["BTC/INR", "LUNA/INR", "BTG/INR", "NEW/INR"],
      download: async (symbol: string) => {
        downloads.push(symbol);
        if (symbol === "BTG/INR") return { error: "BTGUSDT isn't on Binance" };
        if (symbol === "NEW/INR") return { series: dailySeries("2026-08-01", "2026-10-03", 1) };
        return { series: series[symbol] };
      },
      spread: () => 0.001,
      scannerBusy: () => false,
      ...over,
    };
    return { deps, sleeps, downloads };
  }

  beforeEach(() => {
    long._resetDailyLong();
    fs.rmSync(path.join(dataDir, "daily_long.json"), { force: true });
  });

  it("replays each coin's daily candles, counting trades only in its list years, and keeps the results", async () => {
    const { deps, sleeps, downloads } = fakes();
    await long.startDailyLong(false, deps);
    const run = long._dailyLongRun()!;
    expect(run.finishedAt).not.toBeNull();
    expect(downloads).toEqual(["BTC/INR", "LUNA/INR", "BTG/INR", "NEW/INR", "BTG/INR"]);
    expect(run.markets["BTG/INR"]).toMatchObject({ status: "failed", note: "BTGUSDT isn't on Binance" });
    expect(run.markets["NEW/INR"]).toMatchObject({ status: "skipped", note: "Only 63 days of candles" });
    // LUNA's trades all opened in 2022, the one year it was among the biggest.
    const luna = run.markets["LUNA/INR"].totals!;
    const btc = run.markets["BTC/INR"].totals!;
    expect(luna.tight!.trades).toBeGreaterThan(0);
    expect(btc.tight!.trades).toBeGreaterThan(0);
    const years = new Set(Object.keys(run.records.tight!).map((q) => q.slice(0, 4)));
    expect([...years].sort()).toEqual(["2020", "2021", "2022", "2023"]);
    const yearOf = (y: string) =>
      sumRecords(Object.entries(run.records.tight!).filter(([q]) => q.startsWith(y)).flatMap(([, byKey]) => Object.values(byKey)));
    // Bitcoin's own trades plus LUNA's, all in 2022.
    const all = sumRecords(Object.values(run.records.tight!).flatMap((byKey) => Object.values(byKey)));
    expect(all.trades).toBe(btc.tight!.trades + luna.tight!.trades);
    expect(yearOf("2022").trades).toBeGreaterThanOrEqual(luna.tight!.trades);
    // It rested after each burst of work.
    expect(sleeps.length).toBeGreaterThan(2);

    // Kept on the volume: a restart reads it back, and isn't due again for a month.
    long._resetDailyLong();
    long.loadDailyLong();
    expect(long._dailyLongRun()!.records).toEqual(run.records);
    expect(long.dailyLongDue(long._dailyLongRun(), deps.now())).toBe(false);
    expect(long.dailyLongDue(long._dailyLongRun(), deps.now() + 31 * DAY)).toBe(true);
    expect(long.dailyLongDue({ ...run, version: long.DAILY_LONG_VERSION - 1 }, deps.now())).toBe(true);
    const view = long.dailyLongView();
    expect(view).toMatchObject({ running: false, finished: 4, total: 4, cohorts: long.COIN_COHORTS });
    // BTG was tried again at the end.
    expect(view.run!.problems).toEqual([
      { symbol: "NEW/INR", note: "Only 63 days of candles" },
      { symbol: "BTG/INR", note: "BTGUSDT isn't on Binance" },
    ]);
    expect(view.byMarket).toEqual({ "BTC/INR": btc, "LUNA/INR": luna });
  });

  it("saves every setup in a coin's list years, with Bitcoin's last 30 days, for the machine-learning test", async () => {
    const { deps } = fakes({ symbols: () => ["BTC/INR", "LUNA/INR"] });
    await long.startDailyLong(false, deps);
    const run = long._dailyLongRun()!;
    const rows = (symbol: string) => {
      const [header, ...lines] = gunzipSync(fs.readFileSync(path.join(long.dailySetupsDir(), historyJob.setupsFileName(symbol)))).toString().trim().split("\n");
      const cols = header.split(",");
      return lines.map((line) => Object.fromEntries(line.split(",").map((v, k) => [cols[k], v])));
    };
    const luna = rows("LUNA/INR");
    expect(luna.length).toBe(run.markets["LUNA/INR"].setups);
    expect(luna.length).toBeGreaterThan(run.markets["LUNA/INR"].totals!.tight!.trades);
    // Only 2022's, LUNA's one year on the list.
    expect(luna.every((row) => new Date(Number(row.entryMs)).getUTCFullYear() === 2022)).toBe(true);
    // Each with Bitcoin's move over the 30 days before, and its result under each trailing stop.
    const btc = series["BTC/INR"];
    const first = luna[0];
    const k = btc.t.indexOf(Number(first.entryMs) - DAY);
    expect(Number(first.market1hPct)).toBeCloseTo(((btc.c[k] - btc.c[k - 30]) / btc.c[k - 30]) * 100, 2);
    for (const p of ["tight", "balanced", "patient", "fixed"]) expect(first[`r_${p}`]).not.toBe("");
    expect(rows("BTC/INR").length).toBe(run.markets["BTC/INR"].setups);
    expect(long.dailyLongView().run!.setups).toBe(luna.length + rows("BTC/INR").length);
    // A fresh run starts the files again.
    await long.startDailyLong(true, fakes({ symbols: () => [] }).deps);
    expect(fs.existsSync(long.dailySetupsDir())).toBe(false);
  });

  it("counts no classic trade before 2018, the first year with a list known at its start", async () => {
    const { deps } = fakes({ symbols: () => ["BTC/INR"], download: async () => ({ series: dailySeries("2017-08-17", "2019-06-01", 3) }) });
    await long.startDailyLong(false, deps);
    const quarters = Object.keys(long._dailyLongRun()!.classic!);
    expect(quarters.length).toBeGreaterThan(0);
    expect(quarters.every((q) => q >= "2018")).toBe(true);
  });

  it("runs the classic strategies on the same coins' kept candles, and redoes only them when they change", async () => {
    const { deps, downloads } = fakes({ symbols: () => ["BTC/INR", "LUNA/INR"] });
    await long.startDailyLong(false, deps);
    const run = long._dailyLongRun()!;
    expect(downloads).toEqual(["BTC/INR", "LUNA/INR"]);
    expect(run.classicVersion).toBe(long.CLASSIC_VERSION);
    const classic = run.classic!;
    const trades = Object.values(classic).flatMap((byStrategy) => Object.values(byStrategy)).reduce((n, rec) => n + rec!.trades, 0);
    expect(trades).toBeGreaterThan(0);
    // Only in years a coin was on that year's list: LUNA's candles end in 2022, Bitcoin's run 2020–2023.
    expect(Object.keys(classic).every((q) => q >= "2020" && q < "2024")).toBe(true);
    expect(fs.readdirSync(long.dailyCandlesDir()).sort()).toEqual(["BTC_INR.csv.gz", "LUNA_INR.csv.gz"]);
    expect(long.dailyLongView().classic).toEqual(classic);
    // Each closed breakout trade saved with its readings at entry, for the machine-learning test on breakout trades.
    const { readBreakoutSetups } = await import("../../server/history/breakoutSetups");
    const { BREAKOUT_READINGS } = await import("../../src/services/breakoutModel");
    const setups = readBreakoutSetups("coins")!;
    const breakoutTrades = Object.values(classic).reduce((n, q) => n + (q.breakout?.trades ?? 0), 0);
    expect(setups.setups.length).toBeGreaterThan(0);
    expect(setups.setups.length).toBeLessThanOrEqual(breakoutTrades);
    expect(setups.setups.every((s) => ["BTC/INR", "LUNA/INR"].includes(s.symbol) && s.x.length === BREAKOUT_READINGS.length)).toBe(true);
    // Bitcoin's trend at each entry: known once it has 200 days.
    expect(setups.setups.some((s) => s.x[BREAKOUT_READINGS.findIndex((r) => r.name === "marketUp")] !== null)).toBe(true);

    // The strategies changed: redone from the kept candles, nothing downloaded, the traders' results and finish kept.
    const kept = { ...run, classic: undefined, classicVersion: long.CLASSIC_VERSION - 1 };
    fs.writeFileSync(path.join(dataDir, "daily_long.json"), JSON.stringify(kept));
    long._resetDailyLong();
    long.loadDailyLong();
    expect(long.dailyLongDue(long._dailyLongRun(), deps.now())).toBe(false);
    const again = fakes({ symbols: () => ["BTC/INR", "LUNA/INR"] });
    await long.startDailyLong(false, again.deps);
    const redone = long._dailyLongRun()!;
    expect(again.downloads).toEqual([]);
    expect(redone.classic).toEqual(classic);
    expect(redone.records).toEqual(run.records);
    expect(redone.finishedAt).toBe(run.finishedAt);

    // Candles not kept (results from before this): fetched once, then kept.
    fs.rmSync(long.dailyCandlesDir(), { recursive: true, force: true });
    fs.writeFileSync(path.join(dataDir, "daily_long.json"), JSON.stringify(kept));
    long._resetDailyLong();
    long.loadDailyLong();
    const fetched = fakes({ symbols: () => ["BTC/INR", "LUNA/INR"] });
    await long.startDailyLong(false, fetched.deps);
    expect(fetched.downloads.sort()).toEqual(["BTC/INR", "LUNA/INR"]);
    expect(long._dailyLongRun()!.classic).toEqual(classic);
    expect(fs.readdirSync(long.dailyCandlesDir()).length).toBe(2);
  });

  it("carries on after a restart from the next coin, and waits for a scan cycle to finish", async () => {
    const first = fakes({ symbols: () => ["LUNA/INR"] });
    await long.startDailyLong(false, first.deps);
    // Its candles run from August 2020, but only 2022's trades count.
    expect(Object.keys(long._dailyLongRun()!.records.tight!).every((q) => q.startsWith("2022-"))).toBe(true);
    // Unfinished, with LUNA done: the next run replays only Bitcoin.
    const kept = { ...long._dailyLongRun()!, finishedAt: null };
    fs.writeFileSync(path.join(dataDir, "daily_long.json"), JSON.stringify(kept));
    long._resetDailyLong();
    long.loadDailyLong();
    let busy = 3;
    const again = fakes({ symbols: () => ["LUNA/INR", "BTC/INR"], scannerBusy: () => busy-- > 0 });
    await long.startDailyLong(false, again.deps);
    expect(again.downloads).toEqual(["BTC/INR"]);
    expect(again.sleeps.filter((ms) => ms === 500).length).toBe(3);
    expect(long._dailyLongRun()!.markets["LUNA/INR"]).toEqual(kept.markets["LUNA/INR"]);
  });
});

describe("the records the daily trades are judged on", () => {
  beforeEach(() => {
    long._resetDailyLong();
    fs.rmSync(path.join(dataDir, "daily_long.json"), { force: true });
  });

  it("are the finished replay's, and the last finished one's while it replays again", async () => {
    expect(long.dailyLongRecords()).toBeNull();
    const luna = dailySeries("2020-08-21", "2022-06-01", 5);
    const deps = (download: () => Promise<{ series: CandleSeries }>) => ({
      now: () => utc("2026-10-03"),
      sleep: async () => {},
      symbols: () => ["LUNA/INR"],
      download,
      spread: () => 0.001,
      scannerBusy: () => false,
    });
    await long.startDailyLong(false, deps(async () => ({ series: luna })));
    const finished = long._dailyLongRun()!.records;
    expect(Object.keys(finished.tight ?? {}).length).toBeGreaterThan(0);
    expect(long.dailyLongRecords()).toEqual(finished);

    // Replaying from the start again, held up on its first download.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const again = long.startDailyLong(
      true,
      deps(async () => {
        await held;
        return { series: dailySeries("2021-06-01", "2022-06-01", 9) };
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(long._dailyLongRun()!.finishedAt).toBeNull();
    expect(long.dailyLongRecords()).toEqual(finished);
    // Saved with the run, so a restart mid-run keeps them too.
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "daily_long.json"), "utf8")).lastRecords).toEqual(finished);
    release();
    await again;
    expect(long._dailyLongRun()!.finishedAt).not.toBeNull();
    expect(long.dailyLongRecords()).toEqual(long._dailyLongRun()!.records);

    // A run of an older version (other costs: CoinDCX's real fee came in with 3) isn't carried:
    // while the new one replays there are no records, so no trader trades on the old ones.
    long._dailyLongRun()!.version = long.DAILY_LONG_VERSION - 1;
    let releaseNew!: () => void;
    const heldNew = new Promise<void>((resolve) => (releaseNew = resolve));
    const newVersion = long.startDailyLong(
      true,
      deps(async () => {
        await heldNew;
        return { series: luna };
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(long._dailyLongRun()!.version).toBe(long.DAILY_LONG_VERSION);
    expect(long.dailyLongRecords()).toBeNull();
    releaseNew();
    await newVersion;
    expect(long.dailyLongRecords()).toEqual(long._dailyLongRun()!.records);
  });
});

describe("background work", () => {
  it("waits for any of the other jobs that's running", () => {
    let a = false;
    let b = false;
    historyJob.waitForOtherWork(() => a);
    historyJob.waitForOtherWork(() => b);
    expect(historyJob.backgroundWorkBusy()).toBe(false);
    b = true;
    expect(historyJob.backgroundWorkBusy()).toBe(true);
    b = false;
    a = true;
    expect(historyJob.backgroundWorkBusy()).toBe(true);
    a = false;
  });
});
