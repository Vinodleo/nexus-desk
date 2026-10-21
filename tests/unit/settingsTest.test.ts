import { describe, expect, it } from "vitest";
import { appendBars, emptySeries, type CandleSeries } from "../../src/services/historyReplay";
import { breakoutTrades, momentumTop, momentumRise, momentumTrades, type ClassicTrade } from "../../src/services/classicStrategies";
import {
  COSTS_DOUBLED,
  breakoutVariantCell,
  breakoutVariants,
  momentumVariantCell,
  momentumVariants,
  settingsCell,
  settingsResult,
  type SettingsCell,
} from "../../src/services/settingsTest";

// The settings test: breakout and momentum replayed at settings around their
// own (a 3 x 3 grid), a tighter and a looser stop, and double the costs.

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2023-01-01T00:00:00Z");
const always = () => true;

function candles(rows: [number, number, number, number][], from = T0): CandleSeries {
  const s = emptySeries();
  appendBars(s, rows.map(([open, high, low, close], k) => ({ time: "", timestampMs: from + k * DAY, open, high, low, close, volume: 1 })));
  return s;
}
const flat = (days: number, price = 100): [number, number, number, number][] => Array.from({ length: days }, () => [price, price + 1, price - 1, price]);

/** Quiet, then a high above the last 40 days' (but not 55's), then a long climb. */
function climb(): CandleSeries {
  const rows: [number, number, number, number][] = [...flat(20, 100), [100, 110, 100, 100], ...flat(40, 100)];
  rows.push([100, 106, 100, 105]);
  for (let k = 1; k <= 40; k++) rows.push([104 + k, 106 + k, 104 + k, 105 + k]);
  rows.push([144, 144, 119, 120]);
  return candles(rows);
}

describe("other settings in the shared rules", () => {
  it("buys at a shorter high when asked, and keeps 55/20 by default", () => {
    const s = climb();
    // The 110 high is 41 days back at the breakout: inside 55 days, outside 40.
    expect(breakoutTrades("X", s, 0, always)).toHaveLength(0);
    const shorter = breakoutTrades("X", s, 0, always, { entryDays: 40, exitDays: 20, stopAtr: 2 });
    expect(shorter).toHaveLength(1);
    // Entered at the close of day 61 (a candle closes a day after it starts).
    expect(shorter[0].entryMs).toBe(T0 + 62 * DAY);
  });

  it("ranks the rise over other days and holds another number", () => {
    const s = candles(Array.from({ length: 130 }, (_, k): [number, number, number, number] => [100 + k, 101 + k, 99 + k, 100 + k]));
    expect(momentumRise(s, 120, 60)).toBeCloseTo(220 / 160 - 1, 9);
    expect(momentumRise(s, 50, 60)).toBeUndefined();
    const rises = [1, 2, 3, 4, 5].map((rise) => ({ rise }));
    expect(momentumTop(rises).map((x) => x.rise)).toEqual([5, 4, 3]);
    expect(momentumTop(rises, 5)).toHaveLength(5);
  });
});

describe("the settings tried", () => {
  it("puts the traded settings in the middle of each grid, then the extra checks", () => {
    const b = breakoutVariants();
    expect(b.map((v) => v.id)).toEqual(["40/15", "40/20", "40/30", "55/15", "55/20", "55/30", "70/15", "70/20", "70/30", "stop-1.5", "stop-3", COSTS_DOUBLED]);
    expect(b[4].settings).toEqual({ entryDays: 55, exitDays: 20, stopAtr: 2 });
    expect(b[11]).toMatchObject({ costScale: 2, settings: { entryDays: 55, exitDays: 20, stopAtr: 2 } });
    const m = momentumVariants();
    expect(m.map((v) => v.id)).toEqual(["60/2", "60/3", "60/5", "90/2", "90/3", "90/5", "120/2", "120/3", "120/5", COSTS_DOUBLED]);
    expect(m[4].settings).toEqual({ days: 90, hold: 3 });
  });
});

describe("one setting's figures", () => {
  it("averages the trades and counts the years they made money", () => {
    const at = (year: number) => Date.UTC(year, 5, 1);
    const trades = [
      { strategy: "breakout", symbol: "A", entryMs: at(2020), exitMs: at(2020), r: 3 },
      { strategy: "breakout", symbol: "A", entryMs: at(2020), exitMs: at(2020), r: -1 },
      { strategy: "breakout", symbol: "B", entryMs: at(2021), exitMs: at(2021), r: -1 },
      { strategy: "breakout", symbol: "B", entryMs: at(2022), exitMs: at(2022), r: 0.5 },
    ] as ClassicTrade[];
    expect(settingsCell("55/20", trades)).toEqual({ id: "55/20", trades: 4, avgR: 0.375, winPct: 50, yearsUp: 2, years: 3 });
    expect(settingsCell("none", [])).toEqual({ id: "none", trades: 0, avgR: 0, winPct: 0, yearsUp: 0, years: 0 });
  });

  it("replays the traded settings exactly as the replay does, and doubled costs take their share off each trade", () => {
    const s = climb();
    const series = { X: s, Y: candles([...flat(60), [100, 106, 100, 105], ...flat(30, 105), [105, 105, 90, 92]]) };
    const costFor = (symbol: string) => (symbol === "X" ? 0.01 : 0.004);
    const b = breakoutVariants();
    const own = breakoutVariantCell(series, b[4], costFor, always);
    const replayed = Object.entries(series).flatMap(([sym, cs]) => breakoutTrades(sym, cs, costFor(sym), always));
    expect(own.trades).toBe(replayed.length);
    expect(own.avgR).toBeCloseTo(replayed.reduce((a, t) => a + t.r, 0) / replayed.length, 9);
    const doubled = breakoutVariantCell(series, b[11], costFor, always);
    expect(doubled.trades).toBe(own.trades);
    expect(doubled.avgR).toBeLessThan(own.avgR);
    // Each list's eligibility is the replay's: none on the list, no trades.
    expect(breakoutVariantCell(series, b[4], costFor, () => false).trades).toBe(0);
  });

  it("replays momentum at its own settings exactly as the replay does", () => {
    const up = () => true;
    const rising = (step: number) => candles(Array.from({ length: 200 }, (_, k): [number, number, number, number] => [100 + k * step, 101 + k * step, 99 + k * step, 100 + k * step]));
    const coins = { A: rising(1), B: rising(0.5), C: rising(0.2), D: rising(0.1) };
    const m = momentumVariants();
    const own = momentumVariantCell(coins, m[4], up, () => 0.002, always);
    const replayed = momentumTrades(coins, up, () => 0.002, always);
    expect(own.trades).toBe(replayed.length);
    expect(own.avgR).toBeCloseTo(replayed.reduce((a, t) => a + t.r, 0) / replayed.length, 9);
    // Holding 5 takes the fourth coin too; holding 2 leaves the third out.
    expect(momentumVariantCell(coins, m[5], up, () => 0.002, always).trades).toBeGreaterThan(own.trades);
    expect(momentumVariantCell(coins, m[3], up, () => 0.002, always).trades).toBeLessThan(own.trades);
  });
});

describe("the verdict", () => {
  const cell = (id: string, avgR: number, trades = 50): SettingsCell => ({ id, trades, avgR, winPct: 40, yearsUp: 6, years: 9 });
  const grid = (rs: number[]) => breakoutVariants().slice(0, 9).map((v, k) => cell(v.id, rs[k]));
  const extra = (doubled: number) => [cell("stop-1.5", 0.3), cell("stop-3", 0.4), cell(COSTS_DOUBLED, doubled)];

  it("holds up when every nearby setting made money and doubled costs still do", () => {
    const r = settingsResult("breakout", [...grid([0.4, 0.5, 0.3, 0.6, 0.87, 0.5, 0.2, 0.3, 0.1]), ...extra(0.7)]);
    expect(r.verdict).toBe("holds");
    expect(r.nearbyUp).toBe(8);
    expect(r.nearbyAvgR).toBeCloseTo((0.4 + 0.5 + 0.3 + 0.6 + 0.87 + 0.5 + 0.2 + 0.3 + 0.1) / 9, 9);
    expect(r.rows).toEqual([40, 55, 70]);
    expect(r.cols).toEqual([15, 20, 30]);
    expect(r.extra.map((c) => c.id)).toEqual(["stop-1.5", "stop-3", COSTS_DOUBLED]);
  });

  it("is mixed when a few nearby settings lose", () => {
    expect(settingsResult("breakout", [...grid([0.4, -0.1, 0.3, 0.6, 0.87, 0.5, -0.2, 0.3, 0.1]), ...extra(0.7)]).verdict).toBe("mixed");
  });

  it("is fragile when most nearby settings lose, or doubled costs turn it to a loss", () => {
    expect(settingsResult("breakout", [...grid([-0.4, -0.1, 0.3, -0.6, 0.87, 0.5, -0.2, -0.3, -0.1]), ...extra(0.7)]).verdict).toBe("fragile");
    expect(settingsResult("breakout", [...grid([0.4, 0.5, 0.3, 0.6, 0.87, 0.5, 0.2, 0.3, 0.1]), ...extra(-0.05)]).verdict).toBe("fragile");
  });

  it("doesn't count a setting with no trades as making money", () => {
    const rs = [0.4, 0.5, 0.3, 0.6, 0.87, 0.5, 0.2, 0.3, 0.1];
    const cells = breakoutVariants().slice(0, 9).map((v, k) => cell(v.id, rs[k], k === 0 ? 0 : 50));
    const r = settingsResult("breakout", [...cells, ...extra(0.7)]);
    expect(r.nearbyUp).toBe(7);
    expect(r.verdict).toBe("mixed");
  });

  it("reads momentum's grid as days by how many it holds", () => {
    const cells = momentumVariants().map((v) => cell(v.id, 0.2));
    const r = settingsResult("momentum", cells);
    expect(r.rows).toEqual([60, 90, 120]);
    expect(r.cols).toEqual([2, 3, 5]);
    expect(r.extra.map((c) => c.id)).toEqual([COSTS_DOUBLED]);
    expect(r.verdict).toBe("holds");
  });
});
