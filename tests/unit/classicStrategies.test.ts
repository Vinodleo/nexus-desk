import { describe, expect, it } from "vitest";
import { appendBars, emptySeries, type CandleSeries } from "../../src/services/historyReplay";
import {
  addClassicTrades,
  atr,
  breakoutEntryAt,
  breakoutExitAt,
  breakoutTrades,
  btcUptrend,
  maTrendTrades,
  momentumTrades,
  resultR,
  sma,
  stockWeekClose,
  type ClassicRecords,
} from "../../src/services/classicStrategies";

// Step 2 of trading slower: strategies with long public records, on daily
// coin candles, each trade's result in R after costs.

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2023-01-01T00:00:00Z"); // a Sunday: its candle closes on Monday
const always = () => true;

/** Daily candles from `T0`, each [open, high, low, close]. */
function candles(rows: [number, number, number, number][]): CandleSeries {
  const s = emptySeries();
  appendBars(s, rows.map(([open, high, low, close], k) => ({ time: "", timestampMs: T0 + k * DAY, open, high, low, close, volume: 1 })));
  return s;
}
const flat = (days: number, price = 100): [number, number, number, number][] => Array.from({ length: days }, () => [price, price + 1, price - 1, price]);

describe("the classic strategies' sums", () => {
  it("average and true range as usual, and a result in R after costs", () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([undefined, 1.5, 2.5, 3.5]);
    const s = candles([...flat(21), [100, 104, 100, 103]]);
    // Twenty days of a 2-point range, then one of 4: a 20-day average of 2.1 by then.
    expect(atr(s)[20]).toBeCloseTo(2, 9);
    expect(atr(s)[21]).toBeCloseTo((19 * 2 + 4) / 20, 9);
    expect(atr(s)[19]).toBeUndefined();
    // 10% up on a 5% stop, 0.5% of costs: (10 − 0.5) / 5.
    expect(resultR(100, 110, 5, 0.005)).toBeCloseTo(1.9, 9);
  });
});

describe("breakout 55/20", () => {
  // 60 quiet days, a close above the 55-day high, 40 days up, then a close below the 20-day low.
  const rows: [number, number, number, number][] = [...flat(60), [100, 106, 100, 105]];
  for (let k = 1; k <= 40; k++) rows.push([104 + k, 106 + k, 104 + k, 105 + k]);
  rows.push([144, 144, 119, 120]);
  const s = candles(rows);

  it("buys a close above the last 55 days' high and sells a close below the last 20 days' low", () => {
    const trades = breakoutTrades("SOL/INR", s, 0.004, always);
    expect(trades.length).toBe(1);
    const [t] = trades;
    expect(t.entryMs).toBe(T0 + 61 * DAY);
    expect(t.exitMs).toBe(T0 + 102 * DAY);
    // Risk: 2 ATR at entry, (19 × 2 + 6) / 20 = 2.2 each.
    expect(t.r).toBeCloseTo(resultR(105, 120, 4.4, 0.004), 9);
    expect(t.open).toBeUndefined();
  });

  it("stops out 2 ATR below the entry, at the open when it gaps through", () => {
    const gap = candles([...rows.slice(0, 61), [95, 96, 94, 96]]);
    const [t] = breakoutTrades("SOL/INR", gap, 0, always);
    expect(t.exitMs).toBe(T0 + 62 * DAY);
    expect(t.r).toBeCloseTo(resultR(105, 95, 4.4, 0), 9);
  });

  it("reads a day's entry and exit the same way the daily paper trades do", () => {
    // Day 60 closes above the 55-day high: in at its close, 2 ATR of risk.
    expect(breakoutEntryAt(s, 60)).toEqual({ entry: 105, risk: expect.closeTo(4.4, 9), atr: expect.closeTo(2.2, 9) });
    // Not on a quiet day, nor before 55 days of history.
    expect(breakoutEntryAt(s, 59)).toBeNull();
    expect(breakoutEntryAt(candles([...flat(40), [100, 106, 100, 105]]), 40)).toBeNull();
    // The last day closes below the 20-day low; the day before doesn't.
    expect(breakoutExitAt(s, 101)).toBe(true);
    expect(breakoutExitAt(s, 100)).toBe(false);
  });

  it("opens only on a coin on that year's list, and judges a trade still open at the last close", () => {
    expect(breakoutTrades("SOL/INR", s, 0, () => false)).toEqual([]);
    const running = candles(rows.slice(0, 80));
    const [t] = breakoutTrades("SOL/INR", running, 0, always);
    expect(t).toMatchObject({ open: true, exitMs: T0 + 80 * DAY });
    expect(t.r).toBeCloseTo(resultR(105, running.c[79], 4.4, 0), 9);
  });
});

describe("moving averages 50/200", () => {
  // 200 flat days, then rising half a point a day.
  const rows: [number, number, number, number][] = flat(200);
  for (let k = 1; k <= 60; k++) rows.push([99.5 + k * 0.5, 101 + k * 0.5, 99 + k * 0.5, 100 + k * 0.5]);
  const s = candles(rows);

  it("buys when the 50-day turns above the 200-day while Bitcoin is above its own, and sells when Bitcoin falls below it", () => {
    const btcUp = (day: number) => day < T0 + 240 * DAY;
    const [t, ...rest] = maTrendTrades("SOL/INR", s, btcUp, 0.002, always);
    expect(rest).toEqual([]);
    expect(t.entryMs).toBe(T0 + 201 * DAY);
    expect(t.exitMs).toBe(T0 + 241 * DAY);
    // Risk: 3 ATR at entry (a 2-point range).
    expect(t.r).toBeCloseTo(resultR(s.c[200], s.c[240], 3 * atr(s)[200]!, 0.002), 9);
  });

  it("doesn't buy while Bitcoin is below its 200-day average, or before it has one", () => {
    expect(maTrendTrades("SOL/INR", s, () => false, 0, always)).toEqual([]);
    expect(maTrendTrades("SOL/INR", s, () => undefined, 0, always)).toEqual([]);
  });

  it("reads Bitcoin's trend from its own 200-day average", () => {
    const btc = candles([...flat(199), [100, 102, 99, 101], [101, 101, 95, 96]]);
    const up = btcUptrend(btc);
    expect(up(T0 + 198 * DAY)).toBeUndefined();
    expect(up(T0 + 199 * DAY)).toBe(true);
    expect(up(T0 + 200 * DAY)).toBe(false);
  });
});

describe("momentum, top 3", () => {
  /** A coin rising (or falling) by `daily` a day, a 2% range. */
  const coin = (daily: number, days = 200) => {
    let p = 100;
    return candles(
      Array.from({ length: days }, () => {
        const o = p;
        p *= 1 + daily;
        return [o, p * 1.01, p * 0.99, p] as [number, number, number, number];
      })
    );
  };
  const coins = { "A/INR": coin(0.004), "B/INR": coin(0.003), "C/INR": coin(0.002), "D/INR": coin(-0.001), "E/INR": coin(0.001) };
  // Bitcoin in an uptrend until day 150.
  const btcUp = (day: number) => day < T0 + 150 * DAY;

  it("holds the 3 coins that rose most over 90 days from a Monday, and sells them all once Bitcoin turns down", () => {
    const trades = momentumTrades(coins, btcUp, () => 0.003, () => true);
    expect(trades.map((t) => t.symbol).sort()).toEqual(["A/INR", "B/INR", "C/INR"]);
    // Bought at the first Monday close with 90 days behind it (day 91), sold at the first Monday after day 150 (day 154).
    for (const t of trades) {
      expect(t.entryMs).toBe(T0 + 92 * DAY);
      expect(t.exitMs).toBe(T0 + 155 * DAY);
    }
    const a = trades.find((t) => t.symbol === "A/INR")!;
    const s = coins["A/INR"];
    expect(a.r).toBeCloseTo(resultR(s.c[91], s.c[154], 3 * atr(s)[91]!, 0.003), 9);
  });

  it("picks only from the year's list, never a coin that fell", () => {
    const trades = momentumTrades(coins, btcUp, () => 0, (symbol) => symbol !== "B/INR");
    expect(trades.map((t) => t.symbol).sort()).toEqual(["A/INR", "C/INR", "E/INR"]);
    const none = momentumTrades({ "D/INR": coins["D/INR"] }, btcUp, () => 0, () => true);
    expect(none).toEqual([]);
  });
});

describe("momentum on stocks", () => {
  const HOUR = 60 * 60 * 1000;
  /** Weekday candles only (as stocks trade), from Monday 4 Jan 2016, each starting at `offset` past UTC midnight. */
  function weekdays(daily: number, count: number, offset: number): CandleSeries {
    const s = emptySeries();
    let p = 100;
    const bars = [];
    for (let d = 0; bars.length < count; d++) {
      const start = Date.parse("2016-01-04T00:00:00Z") + d * DAY;
      const weekday = new Date(start).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const o = p;
      p *= 1 + daily;
      bars.push({ time: "", timestampMs: start + offset, open: o, high: p * 1.01, low: p * 0.99, close: p, volume: 1 });
    }
    appendBars(s, bars);
    return s;
  }

  it("rebalances at each week's last session, which stocks have and coins' Sunday rule never finds", () => {
    // New York's candles start at 05:00 UTC; India's at 18:30 UTC the day before.
    const us = { "A.US": weekdays(0.004, 200, 5 * HOUR), "B.US": weekdays(0.002, 200, 5 * HOUR) };
    const up = () => true;
    expect(momentumTrades(us, up, () => 0, () => true)).toEqual([]);
    const trades = momentumTrades(us, up, () => 0, () => true, stockWeekClose);
    expect(trades.map((t) => t.symbol).sort()).toEqual(["A.US", "B.US"]);
    // Bought at the first Friday with 90 sessions behind it: Friday 13 May 2016 (the 95th session).
    for (const t of trades) expect(new Date(t.entryMs - DAY).toISOString().slice(0, 10)).toBe("2016-05-13");

    // India's Friday candle starts on Thursday 18:30 UTC, and still closes the week.
    const friday = Date.parse("2016-01-07T18:30:00Z");
    expect(stockWeekClose(friday, friday + 3 * DAY)).toBe(true);
    expect(stockWeekClose(friday - DAY, friday)).toBe(false);
    // The last candle has no next one: no rebalance on it.
    expect(stockWeekClose(friday, undefined)).toBe(false);
  });
});

describe("the classic strategies' records", () => {
  it("add each trade to the quarter it opened in", () => {
    const records: ClassicRecords = {};
    addClassicTrades(records, [
      { strategy: "breakout", symbol: "A/INR", entryMs: Date.parse("2022-05-10T00:00:00Z"), exitMs: 0, r: 2 },
      { strategy: "breakout", symbol: "B/INR", entryMs: Date.parse("2022-06-30T00:00:00Z"), exitMs: 0, r: -1 },
      { strategy: "momentum", symbol: "A/INR", entryMs: Date.parse("2022-07-01T00:00:00Z"), exitMs: 0, r: 0.5 },
    ]);
    expect(records).toEqual({
      "2022-Q2": { breakout: { trades: 2, totalR: 1, wins: 1, winR: 2, lossR: -1 } },
      "2022-Q3": { momentum: { trades: 1, totalR: 0.5, wins: 1, winR: 0.5, lossR: 0 } },
    });
  });
});
