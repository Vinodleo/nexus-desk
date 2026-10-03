import fs from "fs";
import os from "os";
import path from "path";
import { gzipSync } from "zlib";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_READINGS, setupCsvHeader, setupCsvRow, type SetupDetail } from "../../src/services/historyReplay";
import { seeded } from "../../src/services/setupModel";

// The machine-learning test on the server: it reads the replay's saved
// setups, learns from the older months and is judged on the latest six.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ml-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const history = await import("../../server/history/historyJob");
const long = await import("../../server/history/dailyLong");
const ml = await import("../../server/history/mlTest");

const PROFILES = ["tight", "balanced", "patient", "fixed"] as const;
const DAY = 24 * 3_600_000;
const toMs = Date.parse("2026-10-01T00:00:00Z");
const fromMs = toMs - 730 * DAY;
const RSI = SETUP_READINGS.indexOf("rsi");

/**
 * A market's saved setups over the two years. With `edge`, those with RSI
 * under 30 average +0.6R and the rest −0.3R; without, all average −0.2R.
 */
function writeSetups(symbol: string, count: number, edge: boolean, seed: number): number {
  const random = seeded(seed);
  const step = (toMs - fromMs) / count;
  const rows = Array.from({ length: count }, (_, k): SetupDetail => {
    const readings = SETUP_READINGS.map(() => random() * 100);
    const mean = edge ? (readings[RSI] < 30 ? 0.6 : -0.3) : -0.2;
    return {
      entryMs: Math.round(fromMs + k * step),
      trader: k % 2 ? "Sofia Range Scalp" : "Diego Aggressive Breakout",
      direction: "LONG",
      regime: "ranging_tight",
      macro: "neutral",
      minute: 600,
      weekday: 3,
      readings,
      results: { tight: { r: mean + (random() - 0.5) * 2, bars: 6 } },
    };
  });
  const csv = `${setupCsvHeader([...PROFILES])}\n${rows.map((d) => setupCsvRow(d, [...PROFILES])).join("\n")}\n`;
  fs.mkdirSync(history.setupsDir(), { recursive: true });
  fs.writeFileSync(path.join(history.setupsDir(), history.setupsFileName(symbol)), gzipSync(csv));
  return count;
}

/** A finished replay, as kept on the volume, with these markets' setups saved. */
function finishedReplay(markets: Record<string, number>) {
  const run = {
    version: history.HISTORY_VERSION,
    startedAt: toMs,
    finishedAt: toMs + 3_600_000,
    fromMs,
    toMs,
    traders: [],
    markets: Object.fromEntries(Object.entries(markets).map(([s, n]) => [s, { status: "done", candles: 5000, setups: n, setupBytes: 1 }])),
    records: {},
  };
  fs.writeFileSync(path.join(dataDir, "history_results.json"), JSON.stringify(run));
  history._resetHistoryJob();
  history.loadHistory();
}

const MB = 1024 * 1024;
const deps = { now: () => Date.now(), sleep: async () => {}, scannerBusy: () => false, profile: () => "tight", memory: () => 200 * MB };

beforeEach(() => {
  ml._resetMlTest();
  history._resetHistoryJob();
  long._resetDailyLong();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the machine-learning test", () => {
  it("learns from the older months and passes only the market where it finds a real edge in the latest six", async () => {
    finishedReplay({
      "BTC/INR": writeSetups("BTC/INR", 12_000, true, 1),
      "ETH/INR": writeSetups("ETH/INR", 12_000, true, 2),
      "SPY.US": writeSetups("SPY.US", 12_000, false, 3),
    });
    expect(ml.mlTestDue()).toBe(true);
    await ml.startMlTest(deps);
    const view = ml.mlTestView();
    expect(view.error).toBeNull();
    const result = view.result!;
    expect(result.periods).toEqual({ trainFrom: fromMs, validFrom: toMs - 273 * DAY, testFrom: toMs - 182 * DAY, testTo: toMs });
    // Each period's setups, by when they came.
    expect(result.setups.test).toBeCloseTo((36_000 * 182) / 730, -2);
    expect(result.setups.trainUsed).toBe(result.setups.train);
    expect(result.markets.crypto!.everySetup.avgR).toBeLessThan(0);
    expect(result.markets.crypto!.passed).toBe(true);
    expect(result.markets.us!.passed).toBe(false);
    expect(result.markets.nse).toBeNull();
    expect(result.importance[0].label).toBe("RSI");
    // Kept, and not due again until another replay finishes.
    expect(fs.existsSync(path.join(dataDir, "ml_test.json"))).toBe(true);
    expect(ml.mlTestDue()).toBe(false);
    ml._resetMlTest();
    ml.loadMlTest();
    expect(ml.mlTestView().result).toEqual(result);
  });

  it("waits for a finished replay with saved setups, and says why it couldn't run", async () => {
    expect(ml.mlTestDue()).toBe(false);
    expect(ml.mlTestView().ready).toBe(false);
    // A replay kept, but its files gone: it says so instead of judging nothing.
    finishedReplay({ "BTC/INR": 100 });
    expect(ml.mlTestView().ready).toBe(true);
    await ml.startMlTest(deps);
    expect(ml.mlTestView().error).toBe("Too few saved setups in one of the periods.");
    expect(ml.mlTestView().result).toBeNull();
  });

  it("fits what it loads to the server's free memory, and stops before the server runs out", async () => {
    finishedReplay({ "BTC/INR": writeSetups("BTC/INR", 12_000, true, 1), "SPY.US": writeSetups("SPY.US", 12_000, false, 3) });
    // Nearly full already: it doesn't start loading.
    await ml.startMlTest({ ...deps, memory: () => 339.9 * MB });
    expect(ml.mlTestView().error).toBe("Not enough free memory on the server (340 MB in use); try again later.");
    // Memory climbing past the line part-way: it stops, and keeps no verdict from it.
    ml._resetMlTest();
    let reads = 0;
    await ml.startMlTest({ ...deps, memory: () => (reads++ > 3 ? (ml.MEMORY_STOP_MB + 1) * MB : 200 * MB) });
    expect(ml.mlTestView().error).toBe(`Stopped to keep the server safe: its memory reached ${ml.MEMORY_STOP_MB + 1} MB.`);
    expect(ml.mlTestView().result).toBeNull();
  });

  it("loads only an even spread of training setups past its cap", async () => {
    finishedReplay({ "BTC/INR": writeSetups("BTC/INR", 12_000, true, 1), "SPY.US": writeSetups("SPY.US", 12_000, false, 3) });
    await ml.startMlTest({ ...deps, maxTrainSetups: 5000 });
    const { setups } = ml.mlTestView().result!;
    // Every 4th of the ~15,000 training setups; all validation and test ones.
    expect(setups.train).toBeGreaterThan(15_000);
    expect(setups.trainUsed).toBe(Math.ceil(setups.train / Math.ceil(setups.train / 5000)));
    expect(setups.valid + setups.test + setups.train).toBe(24_000);
  });
});

describe("the machine-learning test on daily coin trades", () => {
  const MARKET = SETUP_READINGS.indexOf("market1hPct");
  const longTo = Date.parse("2026-10-01T00:00:00Z");
  const longFrom = Date.parse("2017-08-01T00:00:00Z");

  /** A coin's daily setups since 2017, two traders, one every 12 hours each, held 2 days: those after Bitcoin rose average +0.5R, the rest −0.3R. */
  function writeDaily(symbol: string, seed: number): number {
    const random = seeded(seed);
    const rows: SetupDetail[] = [];
    for (let t = longFrom; t < longTo; t += DAY / 2) {
      for (const trader of ["Chen Conservative Trend", "Marcus Swing Trend"]) {
        const readings = SETUP_READINGS.map(() => random() * 100 - 50);
        const mean = readings[MARKET] > 0 ? 0.5 : -0.3;
        rows.push({ entryMs: t, trader, direction: "LONG", regime: "trending_bullish", macro: "neutral", minute: 0, weekday: 3, readings, results: { tight: { r: mean + (random() - 0.5) * 2, bars: 2 } } });
      }
    }
    const csv = `${setupCsvHeader([...PROFILES])}\n${rows.map((d) => setupCsvRow(d, [...PROFILES])).join("\n")}\n`;
    fs.mkdirSync(long.dailySetupsDir(), { recursive: true });
    fs.writeFileSync(path.join(long.dailySetupsDir(), history.setupsFileName(symbol)), gzipSync(csv));
    return rows.length;
  }

  /** A finished replay since 2017, as kept on the volume, with these coins' setups saved. */
  function finishedLong(markets: Record<string, number>) {
    const run = {
      version: long.DAILY_LONG_VERSION,
      startedAt: longTo,
      finishedAt: longTo + 3_600_000,
      fromMs: longFrom,
      toMs: longTo,
      traders: [],
      markets: Object.fromEntries(Object.entries(markets).map(([s, n]) => [s, { status: "done", candles: 3000, setups: n, setupBytes: 1 }])),
      records: {},
    };
    fs.writeFileSync(path.join(dataDir, "daily_long.json"), JSON.stringify(run));
    long._resetDailyLong();
    long.loadDailyLong();
  }

  it("learns from the older years, tunes on the year after and is judged on the latest year, a trade a pair at a time over days", async () => {
    finishedLong({ "BTC/INR": writeDaily("BTC/INR", 1), "ETH/INR": writeDaily("ETH/INR", 2) });
    expect(ml.mlTestDue("daily")).toBe(true);
    expect(ml.mlTestDue("5m")).toBe(false);
    expect(ml.mlTestView().daily.ready).toBe(true);
    // Only the daily test can run (no two-year replay here).
    await ml.startMlTest(deps);
    const view = ml.mlTestView();
    expect(view.error).toBeNull();
    expect(view.result).toBeNull();
    const result = view.daily.result!;
    expect(result.periods).toEqual({ trainFrom: longFrom, validFrom: longTo - 730 * DAY, testFrom: longTo - 365 * DAY, testTo: longTo });
    // Held 2 days, one at a time per coin and trader: a trade every 2 days, 4 pairs, over the latest year.
    expect(result.markets.crypto!.everySetup.trades).toBeGreaterThan(700);
    expect(result.markets.crypto!.everySetup.trades).toBeLessThan(740);
    expect(result.markets.crypto!.passed).toBe(true);
    expect(result.markets.crypto!.picks.avgR).toBeGreaterThan(result.markets.crypto!.everySetup.avgR);
    expect(result.markets.us).toBeNull();
    expect(result.importance[0].label).toBe("Bitcoin's last 30 days");
    // Kept on its own, and not due again until the replay finishes again.
    expect(fs.existsSync(path.join(dataDir, "ml_test_daily.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "ml_test.json"))).toBe(false);
    expect(ml.mlTestDue("daily")).toBe(false);
    ml._resetMlTest();
    ml.loadMlTest();
    expect(ml.mlTestView().daily.result).toEqual(result);
  });

  it("runs both tests one after the other when both replays have finished", async () => {
    finishedLong({ "BTC/INR": writeDaily("BTC/INR", 1) });
    finishedReplay({ "BTC/INR": writeSetups("BTC/INR", 12_000, true, 1), "SPY.US": writeSetups("SPY.US", 12_000, false, 3) });
    expect(ml.mlTestDue()).toBe(true);
    await ml.startMlTest(deps);
    expect(ml.mlTestView().result).not.toBeNull();
    expect(ml.mlTestView().daily.result).not.toBeNull();
    expect(ml.mlTestDue()).toBe(false);
  });
});
