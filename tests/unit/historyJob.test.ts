import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketBar } from "../../src/types";
import { appendBars, emptySeries, type CandleSeries } from "../../src/services/historyReplay";
import type { HistoryFetch } from "../../server/history/historyCandles";

// The background job that replays two years of every market: it saves
// each market as it finishes, carries on after a restart, retries failures,
// rests between bursts of work, and downloads Indian stocks only while NSE
// is closed.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-history-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});

const job = await import("../../server/history/historyJob");
const { CPU_SHARE, HISTORY_DAYS, HISTORY_VERSION, MAX_SETUP_BYTES, RERUN_AFTER_MS, historyView, loadHistory, needsRun, setupsDir, startHistoryRun, _historyRun, _resetHistoryJob } = job;
const { gunzipSync } = await import("zlib");

/** A market's saved setups: the header's columns, and each row as named fields. */
function savedSetups(file: string): Record<string, string>[] {
  const [header, ...lines] = gunzipSync(fs.readFileSync(path.join(setupsDir(), file))).toString().trim().split("\n");
  const cols = header.split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((v, k) => [cols[k], v])));
}
type HistoryDeps = import("../../server/history/historyJob").HistoryDeps;

const FIVE = 5 * 60_000;
const DAY = 24 * 3_600_000;

/** `count` candles from `startIso`, only at times `open` allows (a market's sessions), wandering. */
function series(startIso: string, count: number, open: (t: number) => boolean = () => true, seed = 5): CandleSeries {
  const s = emptySeries();
  const bars: MarketBar[] = [];
  let p = 100;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = Date.parse(startIso); bars.length < count; t += FIVE) {
    if (!open(t)) continue;
    const o = p;
    p *= 1 + (rnd() - 0.5) * 0.006;
    bars.push({ time: "", timestampMs: t, open: o, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, close: p, volume: 1000 + rnd() * 4000 });
  }
  appendBars(s, bars);
  return s;
}
const istMinute = (t: number) => (t / 60_000 + 330) % 1440;
const nseOpen = (t: number) => [1, 2, 3, 4, 5].includes(new Date(t + 330 * 60_000).getUTCDay()) && istMinute(t) >= 555 && istMinute(t) < 930;

function fakes(over: Partial<HistoryDeps> = {}, startIso = "2026-10-01T12:00:00Z") {
  let clock = Date.parse(startIso);
  const sleeps: number[] = [];
  const downloads: { symbol: string; at: number }[] = [];
  const deps: HistoryDeps = {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    symbols: async () => ["BTC/INR", "AAPL.US", "RELIANCE"],
    download: async (symbol): Promise<HistoryFetch> => {
      downloads.push({ symbol, at: clock });
      if (symbol === "RELIANCE") return { series: series("2026-06-01T03:45:00Z", 1500, nseOpen) };
      return { series: series("2026-06-01T00:00:00Z", 1500) };
    },
    spread: () => 0.0005,
    scannerBusy: () => false,
    ...over,
  };
  return { deps, sleeps, downloads, advance: (ms: number) => (clock += ms), now: () => clock };
}

beforeEach(() => {
  _resetHistoryJob();
  fs.rmSync(path.join(dataDir, "history_results.json"), { force: true });
  fs.rmSync(path.join(dataDir, "history_setups"), { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, "history_candles_1h"), { recursive: true, force: true });
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the history job", () => {
  it("replays every market over two years, saves the results and shows them", async () => {
    const { deps, sleeps, downloads } = fakes();
    await startHistoryRun(false, deps);
    const run = _historyRun()!;
    expect(run.finishedAt).not.toBeNull();
    expect(run.toMs - run.fromMs).toBe(HISTORY_DAYS * DAY);
    expect(downloads.map((d) => d.symbol)).toEqual(["BTC/INR", "AAPL.US", "RELIANCE"]);
    expect(Object.values(run.markets).map((m) => m.status)).toEqual(["done", "done", "done"]);
    // Every exit profile, every market.
    expect(Object.keys(run.records).sort()).toEqual(["balanced", "fixed", "patient", "tight"]);
    const keys = Object.values(run.records.tight!).flatMap((byKey) => Object.keys(byKey));
    for (const market of ["crypto", "us", "nse"]) expect(keys.some((k) => k.startsWith(`${market}:`))).toBe(true);
    // It rested after each burst of work: two per market here.
    expect(sleeps.length).toBe(6);

    // Kept on the volume: a restart reads it back.
    _resetHistoryJob();
    loadHistory();
    expect(_historyRun()!.markets).toEqual(run.markets);
    const view = historyView();
    expect(view).toMatchObject({ running: false, finished: 3, total: 3 });
    expect(view.run!.markets).toEqual({ crypto: { done: 1, failed: 0, skipped: 0 }, us: { done: 1, failed: 0, skipped: 0 }, nse: { done: 1, failed: 0, skipped: 0 } });
    expect(view.records).toEqual(run.records);
  });

  it("rests so the replay uses only a small share of the CPU", async () => {
    const { deps, sleeps } = fakes({ symbols: async () => ["BTC/INR"] });
    // Each burst of replay work takes 20 ms by the job's clock.
    const now = deps.now;
    let ticks = 0;
    deps.now = () => now() + 20 * ticks++;
    await startHistoryRun(false, deps);
    // 20 ms of work, then a rest of 20 × (1 / CPU_SHARE − 1): about 650 ms.
    expect(sleeps.length).toBe(2);
    for (const ms of sleeps) expect(ms).toBe(Math.round(20 * (1 / CPU_SHARE - 1)));
  });

  it("downloads Indian stocks only once NSE has closed", async () => {
    // Thursday 10:30 IST: NSE is open.
    const { deps, downloads } = fakes({ symbols: async () => ["RELIANCE"] }, "2026-10-01T05:00:00Z");
    await startHistoryRun(false, deps);
    const at = downloads[0].at;
    expect(nseOpen(at) || nseOpen(at - 15 * 60_000)).toBe(false);
    expect(at).toBeGreaterThan(Date.parse("2026-10-01T10:00:00Z"));
    expect(at).toBeLessThan(Date.parse("2026-10-01T11:00:00Z"));
  });

  it("waits for a scan cycle to finish, and tries again when a source asks to slow down", async () => {
    let busy = 3;
    let refusals = 1;
    const { deps, sleeps, downloads } = fakes({
      symbols: async () => ["BTC/INR"],
      scannerBusy: () => busy-- > 0,
    });
    const download = deps.download;
    deps.download = async (symbol, from, to) => (refusals-- > 0 ? { error: "Angel One asked to slow down; historical requests resume in 60s." } : download(symbol, from, to));
    await startHistoryRun(false, deps);
    expect(_historyRun()!.markets["BTC/INR"].status).toBe("done");
    expect(downloads.length).toBe(1);
    expect(sleeps.filter((ms) => ms === 500).length).toBe(3);
    expect(sleeps).toContain(2 * 60_000);
  });

  it("tries a failed market once more at the end, and says why one couldn't be replayed", async () => {
    const { deps, downloads } = fakes({ symbols: async () => ["PEPE/INR", "BTC/INR", "TINY/INR"] });
    const download = deps.download;
    deps.download = async (symbol, from, to) => {
      if (symbol === "PEPE/INR") {
        downloads.push({ symbol, at: 0 });
        return { error: "PEPEUSDT isn't on Binance" };
      }
      if (symbol === "TINY/INR") return { series: series("2026-06-01T00:00:00Z", 200) };
      return download(symbol, from, to);
    };
    await startHistoryRun(false, deps);
    expect(downloads.filter((d) => d.symbol === "PEPE/INR").length).toBe(2);
    const view = historyView();
    expect(view.run!.markets.crypto).toEqual({ done: 1, failed: 1, skipped: 1 });
    expect(view.run!.problems).toEqual([
      { symbol: "TINY/INR", note: "Only 200 candles" },
      { symbol: "PEPE/INR", note: "PEPEUSDT isn't on Binance" },
    ]);
  });

  it("replays a coin whatever its spread now, charging at most the 0.2% the desk trades at", async () => {
    const recordsWith = async (spread: number | undefined) => {
      _resetHistoryJob();
      fs.rmSync(path.join(dataDir, "history_results.json"), { force: true });
      const { deps } = fakes({ symbols: async () => ["BTC/INR"], spread: () => spread });
      await startHistoryRun(false, deps);
      return _historyRun()!;
    };
    // Wider than the desk trades at right now: still replayed, as if traded at 0.2%.
    const wide = await recordsWith(0.01);
    expect(wide.markets["BTC/INR"].status).toBe("done");
    const atLimit = await recordsWith(0.002);
    expect(wide.records).toEqual(atLimit.records);
    // Not read yet: charged the 0.2% too.
    expect((await recordsWith(undefined)).records).toEqual(atLimit.records);
    // A narrower one is charged as it is.
    expect((await recordsWith(0.0005)).records).not.toEqual(atLimit.records);
  });

  it("saves every setup with its readings and results, a compressed file per market", async () => {
    const { deps } = fakes({ symbols: async () => ["BTC/INR", "ETH/INR", "RELIANCE"] });
    await startHistoryRun(false, deps);
    const run = _historyRun()!;
    expect(fs.readdirSync(setupsDir()).sort()).toEqual(["BTC_INR.csv.gz", "ETH_INR.csv.gz", "RELIANCE.csv.gz"]);
    const eth = savedSetups("ETH_INR.csv.gz");
    expect(eth.length).toBe(run.markets["ETH/INR"].setups);
    expect(eth.length).toBeGreaterThan(0);
    expect(run.markets["ETH/INR"].setupBytes).toBe(fs.statSync(path.join(setupsDir(), "ETH_INR.csv.gz")).size);
    for (const row of eth) {
      expect(Number(row.entryMs)).toBeGreaterThan(0);
      expect(row.trader).not.toBe("");
      expect(Number.isFinite(Number(row.rsi))).toBe(true);
      // Bitcoin's last hour, from its candles replayed first.
      expect(row.market1hPct).not.toBe("");
    }
    expect(eth.some((row) => row.r_tight !== "" && row.bars_tight !== "")).toBe(true);
    // Indian stocks have no market leader here.
    expect(savedSetups("RELIANCE.csv.gz").every((row) => row.market1hPct === "")).toBe(true);
    expect(historyView().run!.setups).toEqual({
      count: run.markets["BTC/INR"].setups! + run.markets["ETH/INR"].setups! + run.markets.RELIANCE.setups!,
      bytes: ["BTC/INR", "ETH/INR", "RELIANCE"].reduce((n, s) => n + run.markets[s].setupBytes!, 0),
      full: false,
    });

    // A fresh run starts its files again.
    const again = fakes({ symbols: async () => ["ETH/INR"] });
    await startHistoryRun(true, again.deps);
    expect(fs.readdirSync(setupsDir())).toEqual(["ETH_INR.csv.gz"]);
  });

  it("stops saving setups once their files reach the cap, so they can't fill the disk", async () => {
    const first = fakes({ symbols: async () => ["BTC/INR"] });
    await startHistoryRun(false, first.deps);
    // As if the files so far had reached the cap.
    const saved = { ..._historyRun()!, finishedAt: null };
    saved.markets["BTC/INR"] = { ...saved.markets["BTC/INR"], setupBytes: MAX_SETUP_BYTES };
    fs.writeFileSync(path.join(dataDir, "history_results.json"), JSON.stringify(saved));
    _resetHistoryJob();
    loadHistory();
    const later = fakes({ symbols: async () => ["BTC/INR", "ETH/INR"] });
    await startHistoryRun(false, later.deps);
    const run = _historyRun()!;
    // Still replayed, its results counted; its setups not saved.
    expect(run.markets["ETH/INR"]).toMatchObject({ status: "done", setups: 0, setupBytes: 0 });
    expect(fs.existsSync(path.join(setupsDir(), "ETH_INR.csv.gz"))).toBe(false);
    expect(historyView().run!.setups.full).toBe(true);
  });

  it("keeps each market's hourly candles and replays it on slower candles too", async () => {
    // Six weeks of a coin: enough hours (about 1,000) for hourly trades, too few days for daily ones.
    const { deps } = fakes({
      symbols: async () => ["BTC/INR"],
      download: async () => ({ series: series("2026-06-01T00:00:00Z", 12_000) }),
    });
    await startHistoryRun(false, deps);
    const run = _historyRun()!;
    const [header, ...rows] = gunzipSync(fs.readFileSync(path.join(job.hourlyDir(), "BTC_INR.csv.gz"))).toString().trim().split("\n");
    expect(header).toBe("t,o,h,l,c,v");
    expect(rows.length).toBe(1000);
    const [t] = rows[0].split(",").map(Number);
    expect(t % 3_600_000).toBe(0);
    expect(Object.keys(run.slow!).sort()).toEqual(["1d", "1h"]);
    expect(Object.keys(run.slow!["1h"]!).sort()).toEqual(["balanced", "fixed", "patient", "tight"]);
    expect(run.slow!["1d"]).toEqual({});
    expect(historyView().slow).toEqual(run.slow);
    // A fresh run starts the hourly files again.
    await startHistoryRun(true, fakes({ symbols: async () => [] }).deps);
    expect(fs.existsSync(job.hourlyDir())).toBe(false);
  });

  it("redoes only the slower trades, from the kept hourly candles, when the slower replay changes", async () => {
    const first = fakes({ symbols: async () => ["BTC/INR"], download: async () => ({ series: series("2026-06-01T00:00:00Z", 12_000) }) });
    await startHistoryRun(false, first.deps);
    const done = _historyRun()!;
    expect(done.slowVersion).toBe(job.SLOW_VERSION);
    expect(done.markets["BTC/INR"].slowIncluded).toBe(true);
    expect(job.slowRedoDue(done)).toBe(false);
    // Kept from an older slower replay: its slower results are out of date.
    const old = { ...done, slowVersion: job.SLOW_VERSION - 1, slow: { "1h": {} }, markets: { "BTC/INR": { ...done.markets["BTC/INR"], slowIncluded: undefined } } };
    fs.writeFileSync(path.join(dataDir, "history_results.json"), JSON.stringify(old));
    _resetHistoryJob();
    loadHistory();
    expect(job.slowRedoDue(_historyRun())).toBe(true);
    const again = fakes({ symbols: async () => ["BTC/INR"] });
    await startHistoryRun(false, again.deps);
    const redone = _historyRun()!;
    // Nothing downloaded; the same slower results as replaying from the candles; still the same finish.
    expect(again.downloads).toEqual([]);
    expect(redone.slow).toEqual(done.slow);
    expect(redone.records).toEqual(done.records);
    expect(redone.finishedAt).toBe(done.finishedAt);
    expect(redone.markets["BTC/INR"].slowIncluded).toBe(true);
    expect(job.slowRedoDue(redone)).toBe(false);
  });

  it("carries on after a restart from the next market", async () => {
    const first = fakes({ symbols: async () => ["BTC/INR"] });
    await startHistoryRun(false, first.deps);
    // Saved part-way through a longer list: as if the server restarted before ETH.
    const saved = { ..._historyRun()!, finishedAt: null };
    fs.writeFileSync(path.join(dataDir, "history_results.json"), JSON.stringify(saved));
    _resetHistoryJob();
    loadHistory();
    const later = fakes({ symbols: async () => ["BTC/INR", "ETH/INR"] });
    await startHistoryRun(false, later.deps);
    expect(later.downloads.map((d) => d.symbol)).toEqual(["ETH/INR"]);
    expect(_historyRun()!.startedAt).toBe(saved.startedAt);
    expect(Object.keys(_historyRun()!.markets)).toEqual(["BTC/INR", "ETH/INR"]);
  });

  it("replays again after a week, after an update to the replay, or when the traders change", async () => {
    const { deps } = fakes({ symbols: async () => ["BTC/INR"] });
    await startHistoryRun(false, deps);
    const run = _historyRun()!;
    const done = run.finishedAt!;
    expect(needsRun(run, done + DAY)).toBe(false);
    expect(needsRun(run, done + RERUN_AFTER_MS + 1)).toBe(true);
    expect(needsRun({ ...run, version: HISTORY_VERSION - 1 }, done + DAY)).toBe(true);
    expect(needsRun({ ...run, traders: run.traders.slice(1) }, done + DAY)).toBe(true);
    expect(needsRun(null, done)).toBe(true);
  });
});
