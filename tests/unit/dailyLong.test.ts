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
const memory = await import("../../server/memory");

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
 * Binance, stubbed. The API lists BTCUSDT (from Aug 2017), POLUSDT (from
 * 10 Sept 2024), TONUSDT (Aug 2024 to 30 June 2026, at 2) and GRAMUSDT (Toncoin's
 * name from 2 July 2026, at 3); the archive has MATICUSDT (Apr 2019 to 10 Sept 2024),
 * LUNAUSDT (Terra's, then a new coin from Sept 2022) and OLDUSDT (2025, in
 * microseconds, one month stored rather than deflated).
 */
const LISTED = {
  BTCUSDT: [utc("2017-08-17"), Infinity],
  POLUSDT: [utc("2024-09-10"), Infinity],
  TONUSDT: [utc("2024-08-08"), utc("2026-07-01"), 2],
  GRAMUSDT: [utc("2026-07-02"), Infinity, 3],
} as Record<string, [number, number, number?]>;
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
    const rows = klines(from, Math.min(Number(url.searchParams.get("endTime")) + 1, from + Number(url.searchParams.get("limit")) * DAY, listed[1]), listed[2] ?? 100);
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
    expect(long.cohortFor(2027)).toBe(long.COIN_COHORTS[2026]);
    // 2026's own list: Zcash, Hyperliquid and World Liberty Financial in; Polkadot, Uniswap and Pepe out.
    for (const coin of ["ZEC", "HYPE", "WLFI"]) {
      expect(long.inCohort(`${coin}/INR`, utc("2026-06-01"))).toBe(true);
      expect(long.inCohort(`${coin}/INR`, utc("2025-06-01"))).toBe(false);
    }
    for (const coin of ["DOT", "UNI", "PEPE"]) {
      expect(long.inCohort(`${coin}/INR`, utc("2025-06-01"))).toBe(true);
      expect(long.inCohort(`${coin}/INR`, utc("2026-06-01"))).toBe(false);
    }
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
    expect(coins).toEqual(expect.arrayContaining(["XMR/INR", "LUNA/INR", "BSV/INR", "MATIC/INR", "PEPE/INR", "HYPE/INR", "WLFI/INR"]));
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

  it("follow Toncoin from TON to GRAM, its name on Binance since July 2026, in the replay and the daily check alike", async () => {
    const ton = await candles.fetchCoinDailySince("TON/INR", utc("2017-08-01"), utc("2026-10-03"), noPause);
    if ("error" in ton) throw new Error(ton.error);
    expect(ton.series.t[0]).toBe(utc("2024-08-08"));
    expect(ton.series.c[ton.series.t.indexOf(utc("2026-06-30"))]).toBe(2);
    expect(ton.series.c[ton.series.t.indexOf(utc("2026-07-02"))]).toBe(3);
    expect(ton.series.t.at(-1)).toBe(utc("2026-10-02"));

    // The daily check's last 400 days: TON's up to the switch, then GRAM's, to yesterday.
    const recent = await candles.fetchCoinDaily("TON/INR", 400, utc("2026-10-03"));
    if ("error" in recent) throw new Error(recent.error);
    const { t, c } = recent.series;
    expect(t[0]).toBe(utc("2025-08-29"));
    expect(c[t.indexOf(utc("2026-06-30"))]).toBe(2);
    expect(c[t.indexOf(utc("2026-07-02"))]).toBe(3);
    expect(t.at(-1)).toBe(utc("2026-10-02"));
    // Every day but 1 July, when it traded under neither.
    expect(t.length).toBe(399);

    // Once Binance drops TONUSDT altogether, GRAM's candles still come.
    const kept = LISTED.TONUSDT;
    delete LISTED.TONUSDT;
    try {
      const gram = await candles.fetchCoinDaily("TON/INR", 400, utc("2026-10-03"));
      if ("error" in gram) throw new Error(gram.error);
      expect(gram.series.t[0]).toBe(utc("2026-07-02"));
      expect(gram.series.t.at(-1)).toBe(utc("2026-10-02"));
    } finally {
      LISTED.TONUSDT = kept;
    }
    // Other coins read as before.
    const btc = await candles.fetchCoinDaily("BTC/INR", 400, utc("2026-10-03"));
    if ("error" in btc) throw new Error(btc.error);
    expect(btc.series.t.length).toBe(400);
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
    // More than were traded (one at a time).
    expect(luna.length).toBeGreaterThan(run.markets["LUNA/INR"].totals!.fixed!.trades);
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
    // Momentum's closed trades too, in a file of their own.
    const picks = readBreakoutSetups("coins", "momentum")!;
    const momentumTrades = Object.values(classic).reduce((n, q) => n + (q.momentum?.trades ?? 0), 0);
    expect(picks.savedAt).toBe(setups.savedAt);
    expect(picks.setups.length).toBeGreaterThan(0);
    expect(picks.setups.length).toBeLessThanOrEqual(momentumTrades);
    expect(picks.setups.every((s) => ["BTC/INR", "LUNA/INR"].includes(s.symbol) && s.x.length === BREAKOUT_READINGS.length)).toBe(true);

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

  it("runs the settings test on breakout with the classic strategies, and on its own from the kept candles when it's missing", async () => {
    const { deps } = fakes({ symbols: () => ["BTC/INR", "LUNA/INR"] });
    await long.startDailyLong(false, deps);
    const run = long._dailyLongRun()!;
    const { SETTINGS_TEST_VERSION } = await import("../../src/services/settingsTest");
    expect(run.settingsVersion).toBe(SETTINGS_TEST_VERSION);
    const tested = run.settings!.breakout!;
    expect(tested.grid.map((c) => c.id)).toEqual(["40/15", "40/20", "40/30", "55/15", "55/20", "55/30", "70/15", "70/20", "70/30"]);
    expect(tested.extra.map((c) => c.id)).toEqual(["stop-1.5", "stop-3", "costs-x2"]);
    // Its own settings' cell is breakout's replayed record.
    const breakout = Object.values(run.classic!).reduce(
      (a, q) => ({ trades: a.trades + (q.breakout?.trades ?? 0), totalR: a.totalR + (q.breakout?.totalR ?? 0) }),
      { trades: 0, totalR: 0 }
    );
    expect(tested.grid[4].trades).toBe(breakout.trades);
    expect(tested.grid[4].avgR).toBeCloseTo(breakout.totalR / breakout.trades, 9);
    expect(["holds", "mixed", "fragile"]).toContain(tested.verdict);
    expect(long.dailyLongView().settings).toEqual(run.settings);

    // A finished run from before the test: run from the kept candles, nothing downloaded, the rest kept.
    const kept = { ...run, settings: undefined, settingsVersion: undefined };
    fs.writeFileSync(path.join(dataDir, "daily_long.json"), JSON.stringify(kept));
    long._resetDailyLong();
    long.loadDailyLong();
    const again = fakes({ symbols: () => ["BTC/INR", "LUNA/INR"] });
    await long.startDailyLong(false, again.deps);
    const redone = long._dailyLongRun()!;
    expect(again.downloads).toEqual([]);
    expect(redone.settings).toEqual(run.settings);
    expect(redone.classic).toEqual(run.classic);
    expect(redone.finishedAt).toBe(run.finishedAt);
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

  it("stops when Node's memory is tight, and carries on later from where it was", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    memory._resetMemory({ heapUsed: 230 * 1024 * 1024, heapLimit: 256 * 1024 * 1024, at: Date.now() });
    try {
      await long.startDailyLong(false, fakes({ symbols: () => ["BTC/INR", "LUNA/INR"] }).deps);
    } finally {
      memory._resetMemory();
    }
    // Stopped at its first rest, nothing recorded for the coin it was on, and said so (to Sentry).
    expect(long._dailyLongRun()!.finishedAt).toBeNull();
    expect(long._dailyLongRun()!.markets).toEqual({});
    expect(String(error.mock.calls[0]?.[1])).toContain("Stopped the coin replay since 2017 to keep the server safe");
    expect(long.dailyLongRunning()).toBe(false);
    // Unfinished, so due: it carries on once memory allows.
    await long.startDailyLong(false, fakes({ symbols: () => ["BTC/INR", "LUNA/INR"] }).deps);
    expect(long._dailyLongRun()!.finishedAt).not.toBeNull();
    expect(Object.keys(long._dailyLongRun()!.markets).sort()).toEqual(["BTC/INR", "LUNA/INR"]);
  });

  it("works out the classic strategies again when a fresh run carries on after its last coin", async () => {
    const symbols = () => ["BTC/INR", "LUNA/INR"];
    await long.startDailyLong(false, fakes({ symbols }).deps);
    const last = long._dailyLongRun()!.classic!;
    // Next month's candles differ.
    const next: Record<string, CandleSeries> = { "BTC/INR": dailySeries("2020-01-01", "2023-06-01", 13), "LUNA/INR": dailySeries("2020-08-21", "2022-06-01", 17) };
    const download = async (symbol: string) => ({ series: next[symbol] });
    // A fresh run stopped (a restart, or memory) once its coins are done, during its classic step.
    let restarted = false;
    const fresh = fakes({
      symbols,
      download,
      sleep: async () => {
        const r = long._dailyLongRun();
        if (!restarted && r && r.finishedAt === null && Object.keys(r.markets).length === 2) {
          restarted = true;
          long._resetDailyLong();
          long.loadDailyLong();
        }
      },
    });
    await long.startDailyLong(true, fresh.deps);
    expect(restarted).toBe(true);
    expect(long._dailyLongRun()!.finishedAt).toBeNull();
    // The last run's results on show meanwhile.
    expect(long.dailyLongClassic()).toEqual(last);
    // Carrying on: worked out on this run's candles, not left as the last run's.
    await long.startDailyLong(false, fakes({ symbols, download }).deps);
    const carried = long._dailyLongRun()!;
    expect(carried.finishedAt).not.toBeNull();
    expect(carried.classic).not.toEqual(last);
    long._resetDailyLong();
    fs.rmSync(path.join(dataDir, "daily_long.json"), { force: true });
    await long.startDailyLong(true, fakes({ symbols, download }).deps);
    expect(carried.classic).toEqual(long._dailyLongRun()!.classic);
  });

  it("replays only a coin a new year's list brings, then the classic strategies, keeping the records it judges on meanwhile", async () => {
    const { deps } = fakes({ symbols: () => ["BTC/INR", "LUNA/INR"] });
    await long.startDailyLong(false, deps);
    const run = structuredClone(long._dailyLongRun()!);
    // 2026's list brings Hyperliquid: the finished run lacks it, so it carries on rather than starting again.
    const symbols = ["BTC/INR", "LUNA/INR", "HYPE/INR"];
    expect(long.dailyLongMissing(run, symbols)).toBe(true);
    expect(long.dailyLongDue(run, deps.now())).toBe(false);
    expect(long.dailyLongMissing(run, ["BTC/INR", "LUNA/INR"])).toBe(false);
    expect(long.dailyLongMissing({ ...run, version: long.DAILY_LONG_VERSION - 1 }, symbols)).toBe(false);
    expect(long.dailyLongMissing(null, symbols)).toBe(false);
    expect(long.dailyLongMissing(run)).toBe(true);
    expect(Object.keys(run.classic!).some((q) => q.startsWith("2026"))).toBe(false);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fetched: string[] = [];
    const added = fakes({
      symbols: () => symbols,
      download: async (symbol: string) => {
        fetched.push(symbol);
        await held;
        return { series: symbol === "HYPE/INR" ? dailySeries("2024-11-29", "2026-10-03", 11) : series[symbol] };
      },
    });
    const going = long.startDailyLong(false, added.deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Breakout's record, which decides whether it trades, isn't dropped while the new coin replays.
    expect(long.dailyLongClassic()).toEqual(run.classic);
    expect(long.dailyLongRecords()).toEqual(run.records);
    release();
    await going;
    // Only it is replayed (Bitcoin's candles read again for its market reading).
    expect(fetched).toEqual(["HYPE/INR", "BTC/INR"]);
    const after = long._dailyLongRun()!;
    expect(after.markets["BTC/INR"]).toEqual(run.markets["BTC/INR"]);
    expect(after.markets["LUNA/INR"]).toEqual(run.markets["LUNA/INR"]);
    expect(after.startedAt).toBe(run.startedAt);
    // Its trades count from 2026, its first year on the list, and the classic strategies ran again with it.
    const hype = after.markets["HYPE/INR"];
    expect(hype.status).toBe("done");
    expect(hype.totals!.tight!.trades).toBeGreaterThan(0);
    expect(Object.keys(after.records.tight!).filter((q) => !(q in run.records.tight!)).every((q) => q.startsWith("2026"))).toBe(true);
    expect(Object.keys(after.classic!).some((q) => q.startsWith("2026"))).toBe(true);
    expect(long.dailyLongMissing(after, symbols)).toBe(false);
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
    // Breakout's record since 2018, which decides whether it trades.
    const classic = long._dailyLongRun()!.classic!;
    expect(Object.values(classic).some((q) => (q.breakout?.trades ?? 0) > 0)).toBe(true);
    expect(long.dailyLongClassic()).toEqual(classic);

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
    // Breakout's record stands too, so the monthly replay doesn't pause it; the Lab shows the same.
    expect(long.dailyLongClassic()).toEqual(classic);
    expect(long.dailyLongView().classic).toEqual(classic);
    // Saved with the run, so a restart mid-run keeps them too.
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "daily_long.json"), "utf8"));
    expect(saved.lastRecords).toEqual(finished);
    expect(saved.classic).toEqual(classic);
    long._resetDailyLong();
    long.loadDailyLong();
    expect(long.dailyLongClassic()).toEqual(classic);
    expect(long.dailyLongDue(long._dailyLongRun(), utc("2026-10-03"))).toBe(false);
    release();
    await again;
    // It carries on from where it was after the restart, and its own results replace the last run's.
    await long.startDailyLong(false, deps(async () => ({ series: dailySeries("2021-06-01", "2022-06-01", 9) })));
    expect(long._dailyLongRun()!.finishedAt).not.toBeNull();
    expect(long.dailyLongRecords()).toEqual(long._dailyLongRun()!.records);
    expect(long.dailyLongClassic()).not.toEqual(classic);

    // A run of an older version (other costs: CoinDCX's real fee came in with 3) judges no one,
    // even before its replay can start (other background work first): on show, marked so.
    long._dailyLongRun()!.version = long.DAILY_LONG_VERSION - 1;
    expect(long._dailyLongRun()!.classic).toBeTruthy();
    expect(long.dailyLongRecords()).toBeNull();
    expect(long.dailyLongClassic()).toBeNull();
    expect(long.dailyLongView()).toMatchObject({ stale: true });
    // Due but waiting for that work, it looks again in 15 minutes, not 6 hours.
    expect(long.nextDailyLongCheckMs(true)).toBe(15 * 60 * 1000);
    expect(long.nextDailyLongCheckMs(false)).toBe(6 * 60 * 60 * 1000);
    // Nor is it carried into the new replay: while that runs there are no records.
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
    expect(long.dailyLongClassic()).toBeNull();
    releaseNew();
    await newVersion;
    expect(long.dailyLongRecords()).toEqual(long._dailyLongRun()!.records);
    expect(long.dailyLongView().stale).toBe(false);
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
