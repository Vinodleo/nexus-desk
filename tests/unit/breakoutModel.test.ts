import { describe, expect, it } from "vitest";
import { appendBars, emptySeries } from "../../src/services/historyReplay";
import { atr, breakoutTrades, sma } from "../../src/services/classicStrategies";
import { seeded } from "../../src/services/setupModel";
import { BREAKOUT_READINGS, breakoutReadings, breakoutSetups, marketCandles, MIN_BREAKOUT_PICKS, walkForward, type BreakoutSetup } from "../../src/services/breakoutModel";

// The machine-learning test on breakout 55/20 trades: readings at each
// breakout's close, and a year-by-year test of whether skipping the model's
// least promising half would add profit.

const DAY = 24 * 60 * 60 * 1000;
const start = Date.UTC(2020, 0, 1);

/** Daily candles from [open, high, low, close, volume] rows, a day apart from `start`. */
function series(rows: [number, number, number, number, number][]) {
  const s = emptySeries();
  appendBars(s, rows.map(([open, high, low, close, volume], k) => ({ time: "", timestampMs: start + k * DAY, open, high, low, close, volume })));
  return s;
}

describe("breakout readings", () => {
  it("read the breakout's strength, volatility, rises, volume, its day and the market's trend at the close", () => {
    // 220 quiet days (high 101, low 99, close 100, volume 10), then a close at 106 on 30 volume.
    const rows: [number, number, number, number, number][] = [...Array.from({ length: 220 }, () => [100, 101, 99, 100, 10] as [number, number, number, number, number]), [100, 107, 100, 106, 30]];
    const s = series(rows);
    const i = s.t.length - 1;
    const range = atr(s);
    // The market rose steadily: above its 200-day average.
    const market = marketCandles(series(Array.from({ length: 221 }, (_, k) => [100 + k, 101 + k, 99 + k, 100 + k, 1] as [number, number, number, number, number])));
    const x = breakoutReadings(s, i, range, sma(s.c, 200), market);
    const read = Object.fromEntries(BREAKOUT_READINGS.map((r, k) => [r.name, x[k]]));
    const a = range[i]!;
    expect(read.strength).toBeCloseTo((106 - 101) / a, 6);
    expect(read.atrPct).toBeCloseTo(a / 106, 6);
    expect(read.rise20).toBeCloseTo(0.06, 6);
    expect(read.rise90).toBeCloseTo(0.06, 6);
    expect(read.vs200).toBeCloseTo(106 / ((199 * 100 + 106) / 200) - 1, 6);
    expect(read.volume).toBeCloseTo(3, 6);
    expect(read.dayRange).toBeCloseTo(7 / a, 6);
    expect(read.closeAt).toBeCloseTo(6 / 7, 6);
    expect(read.marketUp).toBe(1);
    expect(read.marketRise).toBeCloseTo(320 / 230 - 1, 6);
    // Without the market or enough history, those readings are missing.
    const early = breakoutReadings(s, 30, range, sma(s.c, 200));
    expect(early.map((v) => Number.isNaN(v))).toEqual([true, false, false, true, true, false, false, false, true, true]);
  });

  it("are saved with each replayed breakout trade, leaving out one still open", () => {
    const quiet = Array.from({ length: 80 }, () => [100, 101, 99, 100, 10] as [number, number, number, number, number]);
    // A breakout, then a fall below the 20-day low (sold), then another breakout still open at the end.
    const rows = [...quiet, [100, 106, 100, 105, 20], [104, 104, 97, 98, 10], ...quiet.slice(0, 60), [100, 108, 100, 107, 20]] as [number, number, number, number, number][];
    const s = series(rows);
    const setups = breakoutSetups(s, breakoutTrades("SOL/INR", s, 0.002, () => true));
    expect(setups).toHaveLength(1);
    expect(setups[0]).toMatchObject({ symbol: "SOL/INR", entryMs: start + 81 * DAY, exitMs: start + 82 * DAY });
    expect(setups[0].r).toBeLessThan(0);
    expect(setups[0].x).toHaveLength(BREAKOUT_READINGS.length);
    expect(setups[0].x[1]).toBeGreaterThan(0);
  });
});

describe("the walk-forward test", () => {
  /** 60 breakouts a year, 2016 to 2025; `result` says how each ends from its readings. */
  function made(result: (x: number[], random: () => number) => number): BreakoutSetup[] {
    const random = seeded(11);
    const out: BreakoutSetup[] = [];
    for (let year = 2016; year <= 2025; year++) {
      for (let k = 0; k < 60; k++) {
        const entryMs = Date.UTC(year, 0, 1) + k * 5 * DAY;
        const x = BREAKOUT_READINGS.map(() => random() * 2);
        out.push({ symbol: `S${k % 20}`, entryMs, exitMs: entryMs + 20 * DAY, r: result(x, random), x });
      }
    }
    return out;
  }

  it("passes when the trades it skips clearly lose: strong breakouts win, weak ones lose", () => {
    const v = walkForward(made((x, random) => (x[0] > 1 ? 2 : -1) + (random() - 0.5)))!;
    // Learns from 2016–2018, sets how choosy on the next year, judges 2020 to 2025.
    expect([v.fromYear, v.toYear]).toEqual([2020, 2025]);
    expect(v.years.map((y) => y.year)).toEqual([2020, 2021, 2022, 2023, 2024, 2025]);
    expect(v.every.trades).toBe(360);
    expect(v.picks.trades + v.skipped.trades).toBe(360);
    expect(v.picks.trades).toBeGreaterThanOrEqual(MIN_BREAKOUT_PICKS);
    expect(v.skipped.avgR).toBeLessThan(0);
    expect(v.picks.avgR).toBeGreaterThan(v.every.avgR);
    expect(v.importance[0]).toMatchObject({ label: "how far above the 55-day high" });
    expect(v.passed).toBe(true);
  });

  it("doesn't pass when the readings say nothing of the result, however good the trades are", () => {
    const v = walkForward(made((_x, random) => (random() < 0.3 ? 4 : -1)))!;
    // Every trade averages about +0.5R; the skipped ones as much: skipping them would only lose profit.
    expect(v.every.avgR).toBeGreaterThan(0.2);
    expect(v.skipped.avgR).toBeGreaterThan(0);
    expect(v.passed).toBe(false);
  });

  it("doesn't pass when its picks are better but the trades it skips still make money: skipping them costs profit", () => {
    // Strong breakouts average about +1.5R, weak ones +0.5R.
    const v = walkForward(made((x, random) => (x[0] > 1 ? 1.5 : 0.5) + (random() - 0.5)))!;
    expect(v.picks.avgR).toBeGreaterThan(v.every.avgR + 0.2);
    expect(v.skipped.avgR).toBeGreaterThan(0.3);
    expect(v.passed).toBe(false);
  });

  it("gives no verdict with too few years to judge one", () => {
    const fewYears = made(() => 1).filter((s) => new Date(s.entryMs).getUTCFullYear() < 2020);
    expect(walkForward(fewYears)).toBeNull();
  });
});
