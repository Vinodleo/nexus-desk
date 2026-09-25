import { describe, expect, it } from "vitest";
import {
  COIN_HOLD_MINUTES,
  COIN_MIN_STOP_PCT,
  COIN_MIN_TARGET_R,
  COIN_REVERSION_MIN_R,
  atrForExits,
  holdMinutesFor,
  hourlyAtrSeries,
  planAtr,
  trailsAsRunner,
} from "../../src/shared/coinHolds";
import { decorateBarsWithIndicators } from "../../src/services/marketDataService";
import { buildMeanReversionSetup, buildTrendSetup } from "../../src/services/strategyEngine";
import { positionFromProposal } from "../../src/services/autopilot";
import type { MarketBar, TradeProposal } from "../../src/types";

// Coin trades are planned on the hourly scale, so CoinDCX's ~0.6% spread
// isn't bigger than the whole risk; stocks stay as they were.

const FIVE = 5 * 60 * 1000;
const T0 = Math.floor(1_790_000_000_000 / FIVE) * FIVE;
/** 5-minute candles whose hour-long blocks each span `hourRange`, around 1000. */
function fiveMinute(n: number, spacing = FIVE): MarketBar[] {
  return Array.from({ length: n }, (_, i) => {
    // Within each hour the price walks up 1 per candle from 1000, then resets.
    const k = i % 12;
    const close = 1000 + k;
    return { time: "", timestampMs: T0 + i * spacing, open: close - 0.5, high: close + 0.5, low: close - 1, close, volume: 100 };
  });
}

describe("the hourly ATR", () => {
  it("averages the true range of hour-long blocks of 5-minute candles", () => {
    const bars = fiveMinute(100);
    const series = hourlyAtrSeries(bars);
    // Needs 6 hours of blocks plus the close before them.
    expect(series[71]).toBeUndefined();
    // Each hour: low 999 (first candle's low) to high 1011.5, and the close
    // before it was 1011: true range 12.5.
    expect(series[72 + 11]).toBeCloseTo(12.5, 6);
  });

  it("is only measured on 5-minute candles, and rides on the candles the scanner decorates", () => {
    expect(hourlyAtrSeries(fiveMinute(100, 60 * 60 * 1000)).every((v) => v === undefined)).toBe(true);
    const decorated = decorateBarsWithIndicators(fiveMinute(100));
    expect(decorated[83].atrHour).toBeCloseTo(12.5, 6);
    expect(decorated[10].atrHour).toBeUndefined();
  });

  it("plans coins on it, stocks on the 5-minute ATR", () => {
    expect(planAtr("SOL/INR", { atr: 2, atrHour: 9, close: 1000 })).toBe(9);
    expect(planAtr("SOL/INR", { atr: 2, close: 1000 })).toBeCloseTo(2 * Math.sqrt(12), 9);
    expect(planAtr("SBIN", { atr: 2, atrHour: 9, close: 1000 })).toBe(2);
  });
});

describe("coin trades", () => {
  const trendBars = (): MarketBar[] => {
    const bars = decorateBarsWithIndicators(
      Array.from({ length: 120 }, (_, i) => {
        const close = 1000 * (1 + 0.0015 * i);
        return { time: "", timestampMs: T0 + i * FIVE, open: close * 0.999, high: close * 1.001, low: close * 0.998, close, volume: 100 };
      })
    );
    return bars.map((b) => ({ ...b, adx: 40 }));
  };
  const ctx = (symbol: string) => ({ symbol, timeframe: "5m", bars: trendBars(), regime: "trending_bullish" as const, eventWindowActive: false });
  const tuning = { idSuffix: "t", name: "Priya", minAdx: 18, stopAtrMult: 1.1, stopPriceFloorPct: 0.003, targetMult: 1.6, baseProbability: 0.5 };

  it("put the stop at least 1.2% away, on the hourly scale, where a stock keeps its 5-minute plan", () => {
    const coin = buildTrendSetup(ctx("SOL/INR"), tuning)!;
    const stock = buildTrendSetup(ctx("SBIN"), tuning)!;
    const stopPct = (s: typeof coin) => (s.entryPrice - s.stopLoss) / s.entryPrice;
    expect(stopPct(coin)).toBeGreaterThanOrEqual(COIN_MIN_STOP_PCT - 1e-4);
    expect(stopPct(stock)).toBeLessThan(0.01);
    expect(coin.planAtr).toBeGreaterThan(stock.planAtr!);
    // Priya's own 1.6× target is widened to the coin minimum of 2×; a stock keeps 1.6×.
    expect((coin.takeProfit - coin.entryPrice) / (coin.entryPrice - coin.stopLoss)).toBeCloseTo(COIN_MIN_TARGET_R, 1);
    expect((stock.takeProfit - stock.entryPrice) / (stock.entryPrice - stock.stopLoss)).toBeCloseTo(1.6, 1);
    expect(coin.riskRewardRatio).toBeCloseTo(2, 1);
  });

  it("aim a range trade at least 2× its stop, since VWAP is often closer than the spread allows", () => {
    const bars = trendBars().map((b) => ({ ...b, rsi: 30, adx: 15, vwap: b.close * 1.001 }));
    const setup = buildMeanReversionSetup(
      { symbol: "SOL/INR", timeframe: "5m", bars, regime: "ranging_tight", eventWindowActive: false },
      { idSuffix: "s", name: "Sofia", rsiOversold: 35, rsiOverbought: 65, maxAdxForRange: 24, stopAtrMult: 0.8, stopPriceFloorPct: 0.003, baseProbability: 0.58 }
    )!;
    expect((setup.takeProfit - setup.entryPrice) / (setup.entryPrice - setup.stopLoss)).toBeGreaterThanOrEqual(COIN_REVERSION_MIN_R - 0.01);
  });

  it("run for 4 hours and trail as runners by their planning ATR", () => {
    expect(holdMinutesFor({ symbol: "SOL/INR", horizon: "intraday" })).toBe(COIN_HOLD_MINUTES);
    expect(holdMinutesFor({ symbol: "SBIN", horizon: "intraday" })).toBe(30);
    expect(holdMinutesFor({ symbol: "SOL/INR", horizon: "swing" })).toBe(4320);
    expect(trailsAsRunner({ family: "mean_reversion", symbol: "SOL/INR" })).toBe(true);
    expect(trailsAsRunner({ family: "mean_reversion", symbol: "SBIN" })).toBe(false);
    expect(atrForExits({ planAtr: 15, entryPrice: 1000 }, 2)).toBe(15);
    expect(atrForExits({ entryPrice: 1000 }, 2)).toBe(3); // 0.3% floor

    const setup = { ...buildTrendSetup(ctx("SOL/INR"), tuning)!, family: "mean_reversion" as const };
    const p = positionFromProposal(
      { proposal: { symbol: "SOL/INR", setup, metaScore: { confidence: 0.6 } } as unknown as TradeProposal, entryPrice: setup.entryPrice, units: 1 },
      { id: "p", atr: atrForExits(setup, 2), trailProfile: "tight" }
    );
    expect(p.expectedHoldingTimeMinutes).toBe(COIN_HOLD_MINUTES);
    expect(p.trailMode).toBe("TREND_RUNNER");
    expect(p.atrAtEntry).toBe(setup.planAtr);
  });
});
