import { describe, expect, it } from "vitest";
import type { MarketBar } from "../../src/types";
import { TRADER_PERSONAS, runPersonaPanel } from "../../src/services/personaEngine";
import { decorateBarsWithIndicators } from "../../src/services/marketDataService";
import { computeMetaLabelScore } from "../../src/services/metaLabeling";
import { panelSetupsOnHistory } from "../../src/services/labSimulation";
import { exitEdgeFor, measureTrades, tableFromTrades, type MeasuredTrade } from "../../src/services/exitExpectancy";
import { MIN_EDGE_R } from "../../src/services/calibration";

// Two traders that read the session itself: Nora trades opening-range
// breakouts on stocks in play (US and Nifty), Ravi late-day momentum on US
// index funds.

const MIN = 60_000;
const nora = TRADER_PERSONAS.find((p) => p.id === "nora-opening-range")!;
const ravi = TRADER_PERSONAS.find((p) => p.id === "ravi-late-momentum")!;

/** A session of 5-minute candles from `openUtc`, flat at `price` unless `over` says otherwise (by candle number). */
function session(openUtc: string, count: number, price: number, over: Record<number, Partial<MarketBar>> = {}): MarketBar[] {
  const t0 = Date.parse(openUtc);
  return Array.from({ length: count }, (_, k) => {
    const ts = t0 + k * 5 * MIN;
    return { time: new Date(ts).toISOString(), timestampMs: ts, open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 5000, ...over[k] };
  });
}

const ctx = (symbol: string, bars: MarketBar[], longOnly = false) => ({
  symbol,
  timeframe: "5m",
  bars: decorateBarsWithIndicators(bars),
  regime: "ranging_tight" as const,
  eventWindowActive: false,
  longOnly,
});
const score = (setup: any) => computeMetaLabelScore({ setup, regime: "ranging_tight", empiricalWinRate: 0.5, sampleCount: 0, similarityScore: 1 });

// ---------- Nora: the opening range, Nifty 50 (9:15 IST = 03:45 UTC) ----------

/** Three earlier sessions whose opening candle traded 10,000 shares. */
const nseEarlier = ["2026-09-22", "2026-09-23", "2026-09-24"].flatMap((d) => session(`${d}T03:45:00Z`, 75, 1400, { 0: { volume: 10_000 } }));
/**
 * Today up to candle `upTo`: a rising opening candle (1,398–1,406) on
 * `openingVolume` shares, one close inside it, then closes above it.
 */
const nseToday = (upTo: number, openingVolume = 30_000, count = upTo + 1) =>
  session("2026-09-25T03:45:00Z", count, 1410, {
    0: { open: 1400, high: 1406, low: 1398, close: 1405, volume: openingVolume },
    1: { open: 1405, high: 1406, low: 1402, close: 1404 },
    2: { open: 1404, high: 1409, low: 1403, close: 1408 },
    3: { open: 1408, high: 1411, low: 1407, close: 1410 },
  }).slice(0, upTo + 1);

describe("Nora, the opening range trader", () => {
  it("buys the first close above a rising opening candle on a stock in play, stopped at the market's minimum", () => {
    const setup = nora.evaluate(ctx("RELIANCE", [...nseEarlier, ...nseToday(2)]))!;
    expect(setup).toMatchObject({ name: "Nora Opening Range", direction: "LONG", qualifies: true, entryPrice: 1408 });
    // The range's far side (1,398) is nearer than an Indian stock's 1.2% minimum, so the minimum sets the stop.
    expect(setup.stopLoss).toBe(1391.1);
    // Three times the stop.
    expect(setup.takeProfit).toBe(1458.69);
    // Its opening volume against the usual.
    expect(setup.features.volumeSurgeRatio).toBe(3);
  });

  it("takes only the first close beyond the range, and only on a stock trading twice its usual opening volume", () => {
    const later = nora.evaluate(ctx("RELIANCE", [...nseEarlier, ...nseToday(3)]))!;
    expect(later.qualifies).toBe(false);
    expect(later.disqualificationReason).toBe("No first close beyond the opening range");
    const quiet = nora.evaluate(ctx("RELIANCE", [...nseEarlier, ...nseToday(2, 12_000)]))!;
    expect(quiet.qualifies).toBe(false);
    expect(quiet.disqualificationReason).toMatch(/Opening volume 1\.2x usual, below 2x/);
  });

  it("waits for enough earlier openings, stops after two hours, and leaves coins alone", () => {
    const oneEarlier = nseEarlier.slice(-75);
    expect(nora.evaluate(ctx("RELIANCE", [...oneEarlier, ...nseToday(2)]))).toBeNull();
    // A candle opening two and a half hours in.
    expect(nora.evaluate(ctx("RELIANCE", [...nseEarlier, ...nseToday(30, 30_000, 31)]))).toBeNull();
    const coin = [...nseEarlier, ...nseToday(2)];
    expect(nora.evaluate(ctx("SOL/INR", coin))).toBeNull();
  });

  it("stops a US breakout at the far side of the range, and sits out a US short", () => {
    // 9:30 New York = 13:30 UTC in September. A falling opening candle, then a close below it.
    const earlier = ["2026-09-22", "2026-09-23", "2026-09-24"].flatMap((d) => session(`${d}T13:30:00Z`, 78, 230, { 0: { volume: 10_000 } }));
    const today = session("2026-09-25T13:30:00Z", 3, 227.5, {
      0: { open: 230, high: 230.5, low: 228, close: 228.4, volume: 25_000 },
      1: { open: 228.4, high: 228.9, low: 228.2, close: 228.6 },
      2: { open: 228.6, high: 228.7, low: 227.3, close: 227.5 },
    });
    const setup = nora.evaluate(ctx("AAPL.US", [...earlier, ...today]))!;
    expect(setup).toMatchObject({ direction: "SHORT", qualifies: true, stopLoss: 230.5, takeProfit: 218.5 });
    // The US desk only buys: the panel sets it aside (it's still followed).
    const panel = runPersonaPanel(ctx("AAPL.US", [...earlier, ...today], true), score);
    expect(panel.candidates.map((s) => s.name)).not.toContain("Nora Opening Range");
    expect(panel.shortOnlySetups?.map((s) => s.name)).toContain("Nora Opening Range");
  });
});

// ---------- Ravi: late-day momentum, US index funds (9:30 New York = 13:30 UTC) ----------

/** Yesterday closing at 500, and today up to 3:20 (71 candles), at `at10` from the 10:00 close on. */
function spyDays(at10: number, yesterdayCandles = 78, todayCandles = 71): MarketBar[] {
  const yesterday = session("2026-09-24T13:30:00Z", yesterdayCandles, 500);
  const today = session("2026-09-25T13:30:00Z", 72, at10, { 0: { open: 500, close: 500.5 }, 1: { close: 500.8 }, 2: { close: 501 }, 3: { close: 500.9 }, 4: { close: 501.2 } });
  return [...yesterday, ...today.slice(0, todayCandles)];
}

describe("Ravi, the late-day momentum trader", () => {
  it("buys an index fund at 3:25 New York time when its first half hour rose", () => {
    const setup = ravi.evaluate(ctx("SPY.US", spyDays(502)))!;
    expect(setup).toMatchObject({ name: "Ravi Late-Day Momentum", direction: "LONG", qualifies: true, entryPrice: 502 });
    // A quiet fund: the stop is at least 0.3% away, and the target twice as far.
    const stop = 502 - setup.stopLoss;
    expect(stop).toBeGreaterThanOrEqual(502 * 0.003 - 0.01);
    expect((setup.takeProfit - 502) / stop).toBeCloseTo(2, 1);
    const panel = runPersonaPanel(ctx("SPY.US", spyDays(502), true), score);
    expect(panel.candidates.map((s) => s.name)).toContain("Ravi Late-Day Momentum");
  });

  it("acts once a day, only on index funds, and needs yesterday's full session", () => {
    // The candle before (closing at 3:20).
    expect(ravi.evaluate(ctx("SPY.US", spyDays(502, 78, 70)))).toBeNull();
    expect(ravi.evaluate(ctx("AAPL.US", spyDays(502)))).toBeNull();
    // Yesterday was a half day (closed at 1:00).
    expect(ravi.evaluate(ctx("SPY.US", spyDays(502, 42)))).toBeNull();
  });

  it("would sell after a falling first half hour, which the US desk sits out", () => {
    const setup = ravi.evaluate(ctx("QQQ.US", spyDays(498)))!;
    expect(setup).toMatchObject({ direction: "SHORT", qualifies: true });
    const panel = runPersonaPanel(ctx("QQQ.US", spyDays(498), true), score);
    expect(panel.candidates.map((s) => s.name)).not.toContain("Ravi Late-Day Momentum");
  });
});

// ---------- judged like everyone else ----------

describe("the replay", () => {
  it("finds their setups on history, reading the whole session, even right after another trader's signal", () => {
    // A market rising steadily over three days (so the range traders don't bet against it), then today's opening.
    const ramp = (openUtc: string, n: number) => {
      const t0 = Date.parse(openUtc);
      return Array.from({ length: 75 }, (_, k): MarketBar => {
        const p = 1340 + (n * 75 + k) * 0.25 + (k % 3) * 0.6;
        const ts = t0 + k * 5 * MIN;
        return { time: new Date(ts).toISOString(), timestampMs: ts, open: p * 0.9995, high: p * 1.002, low: p * 0.998, close: p, volume: k === 0 ? 10_000 : 5000 };
      });
    };
    const earlier = ["2026-09-22", "2026-09-23", "2026-09-24"].flatMap((d, n) => ramp(`${d}T03:45:00Z`, n));
    const bars = decorateBarsWithIndicators([...earlier, ...nseToday(74, 30_000, 75)]);
    const opening = earlier.length;
    const found = panelSetupsOnHistory("RELIANCE", bars);
    const noraAt = found.find((f) => f.setups.some((s) => s.name === "Nora Opening Range"));
    expect(noraAt?.i).toBe(opening + 2);
    // The big opening candle set other traders off two candles before; that doesn't hide Nora's breakout.
    expect(found.find((f) => f.i === opening)?.setups.length).toBeGreaterThan(0);
    // And it's played forward under the live exits into her record.
    const { trades } = measureTrades([{ symbol: "RELIANCE", bars }]);
    expect(trades.some((t) => t.trader === "Nora Opening Range")).toBe(true);
  });

  it("holds a trader with no record yet back from trading until it earns one", () => {
    const others: MeasuredTrade[] = Array.from({ length: 40 }, (_, k) => ({ symbol: "TCS", trader: "Amara Confirmed Breakout", entryMs: k * 3_600_000, exitMs: k * 3_600_000 + 60_000, r: 0.3 }));
    const table = tableFromTrades(others, "balanced", Date.now(), 50);
    const edge = exitEdgeFor(table, "RELIANCE", "Nora Opening Range")!;
    expect(edge).toEqual({ r: 0, trades: 0 });
    expect(edge.r).toBeLessThan(MIN_EDGE_R);
  });
});
