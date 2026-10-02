import { describe, expect, it } from "vitest";
import type { MarketBar, StrategySetup } from "../../src/types";
import {
  aggregateSeries,
  appendBars,
  emptySeries,
  hourOffsetMs,
  replayTimeframe,
  timeframeSeries,
  TIMEFRAME_RULES,
  type CandleSeries,
} from "../../src/services/historyReplay";
import { simulateExit } from "../../src/services/exitComparison";
import { decorateBarsWithIndicators } from "../../src/services/marketDataService";
import { nseDeliveryRoundTripRate, nseRoundTripRate } from "../../src/shared/nse";

// Slower trades: the traders on hourly and daily candles, held for days.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 5-minute candles from `startIso` at the times `open` allows, rising by `step` each, `range` either side. */
function fiveMinute(startIso: string, count: number, open: (t: number) => boolean, step = 0.01, range = 0.2): CandleSeries {
  const bars: MarketBar[] = [];
  let p = 100;
  for (let t = Date.parse(startIso); bars.length < count; t += 5 * MIN) {
    if (!open(t)) continue;
    bars.push({ time: "", timestampMs: t, open: p, high: p + range, low: p - range, close: p + step, volume: 100 });
    p += step;
  }
  const s = emptySeries();
  appendBars(s, bars);
  return s;
}
const ist = (t: number) => (t / MIN + 330) % 1440;
const nseOpen = (t: number) => [1, 2, 3, 4, 5].includes(new Date(t + 330 * MIN).getUTCDay()) && ist(t) >= 555 && ist(t) < 930;

describe("slower candles", () => {
  it("builds hours from each market's open, and days from them", () => {
    expect(hourOffsetMs("RELIANCE")).toBe(45 * MIN);
    expect(hourOffsetMs("SPY.US")).toBe(30 * MIN);
    expect(hourOffsetMs("BTC/INR")).toBe(0);
    // One Nifty session: 9:15 to 3:30 IST is 75 candles.
    const day = fiveMinute("2026-09-24T03:45:00Z", 75, nseOpen);
    const hours = aggregateSeries(day, HOUR, hourOffsetMs("RELIANCE"));
    // 9:15, 10:15 … 2:15, and the last quarter hour from 3:15.
    expect(hours.t.map((t) => new Date(t + 330 * MIN).toISOString().slice(11, 16))).toEqual(["09:15", "10:15", "11:15", "12:15", "13:15", "14:15", "15:15"]);
    expect(hours.o[0]).toBe(day.o[0]);
    expect(hours.c[0]).toBeCloseTo(day.c[11], 9);
    expect(hours.h[0]).toBeCloseTo(Math.max(...day.h.slice(0, 12)), 9);
    expect(hours.v[0]).toBe(1200);
    expect(hours.v[6]).toBe(300);
    const days = timeframeSeries(hours, "1d");
    expect(days.t).toEqual([Date.parse("2026-09-24T00:00:00Z")]);
    expect(days.c[0]).toBe(day.c[74]);
  });

  it("charges an Indian trade held overnight as delivery: about 0.5% a round trip on ₹25,000", () => {
    // Brokerage 2 × ₹20, STT 2 × 0.1%, stamp duty 0.015%, exchange and SEBI charges, the ₹20 depository charge, GST.
    const expected = (40 + 1.75 + 0.05 + 50 + 3.75 + 20 + 0.18 * (40 + 1.75 + 0.05 + 20)) / 25_000;
    expect(nseDeliveryRoundTripRate(25_000)).toBeCloseTo(expected, 9);
    expect(nseDeliveryRoundTripRate(25_000)).toBeGreaterThan(2 * nseRoundTripRate(25_000));
  });

  it("holds a slower stock trade overnight, to its time limit, where today's exits close it before the bell", () => {
    const bars = decorateBarsWithIndicators(
      Array.from({ length: 200 }, (_, k): MarketBar => {
        const t = Date.parse("2026-09-21T03:45:00Z") + Math.floor(k / 7) * DAY + (k % 7) * HOUR;
        return { time: new Date(t).toISOString(), timestampMs: t, open: 100, high: 100.3, low: 99.7, close: 100, volume: 1000 };
      })
    );
    const setup = { name: "Test", family: "mean_reversion", direction: "LONG", symbol: "TCS", entryPrice: 100, stopLoss: 97, takeProfit: 109, features: {} } as unknown as StrategySetup;
    const i = 50;
    const held = { intervalMs: HOUR, holdMs: 2 * DAY, feeRate: 0.005 };
    const slow = simulateExit(setup, bars, i, "tight", 0, held)!;
    expect(slow.reason).toBe("EXPIRY_TIME");
    expect((bars[slow.exitIndex].timestampMs as number) + HOUR - ((bars[i].timestampMs as number) + HOUR)).toBeGreaterThanOrEqual(2 * DAY);
    // Flat: it loses only its costs, 0.5% of the price on a 3% stop.
    expect(slow.r).toBeCloseTo(-0.5 / 3, 6);
  });

  it("replays the traders on hourly and daily candles, taking stock trades only in entry hours, held for days", () => {
    // Four months of a rising Nifty stock, lively enough (hourly swings of about 3%) for stops wide enough to carry delivery costs.
    const five = fiveMinute("2026-01-05T03:45:00Z", 75 * 85, nseOpen, 0.02, 1.5);
    const hourly = aggregateSeries(five, HOUR, hourOffsetMs("RELIANCE"));
    const trades = [...replayTimeframe("RELIANCE", hourly, "1h", ["tight"], 0.005)].flat();
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) {
      // Entered at an hour's close in entry hours (by 3:00 IST)…
      expect(ist(t.entryMs)).toBeLessThanOrEqual(900);
      expect(t.entryMs).toBeGreaterThan(hourly.t[TIMEFRAME_RULES["1h"].warmupBars]);
    }
    // …and some held past the day they opened.
    expect(trades.some((t) => new Date(t.exitMs + 330 * MIN).getUTCDate() !== new Date(t.entryMs + 330 * MIN).getUTCDate())).toBe(true);
    // Dearer costs, lower results, on the same trades.
    const cheap = [...replayTimeframe("RELIANCE", hourly, "1h", ["tight"], 0)].flat();
    const sum = (list: typeof trades) => list.reduce((a, t) => a + t.r, 0) / list.length;
    expect(sum(trades)).toBeLessThan(sum(cheap));
    // Too few days for daily candles' warm-up: none.
    expect([...replayTimeframe("RELIANCE", timeframeSeries(hourly, "1d"), "1d", ["tight"], 0.005)].flat()).toEqual([]);
  });
});
