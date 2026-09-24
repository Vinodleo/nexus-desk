// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { metaFeatures, META_FEATURE_VERSION } from "../../src/services/metaFeatures";
import { candleSpacingMs, hourlyRegimeLookup, replayPanel, simulateTunedBreakout, toLabBars, LAB_COST_PCT } from "../../src/services/labSimulation";
import { fetchRealHistoricalCandles, runRealDataWalkForward, type HistoricalCandle } from "../../src/services/realDataBacktestService";
import { onlineTrainingSet, MIN_ONLINE_SAMPLES } from "../../src/services/onlineLearningService";
import { buildBreakoutSetup, roundPrice } from "../../src/services/strategyEngine";
import { decorateBarsWithIndicators } from "../../src/services/marketDataService";
import { shadowFromSetup } from "../../src/services/shadowTracker";
import type { MarketBar } from "../../src/types";

vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => vi.unstubAllGlobals());

const FIVE = 5 * 60 * 1000;
const T0 = Math.floor(1_790_000_000_000 / (60 * 60 * 1000)) * 60 * 60 * 1000; // on the hour

// A rising market with a sharp, high-volume push every 25 candles: breakouts to find.
function candles(n: number, spacing = FIVE, base = 1000): HistoricalCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const push = i % 25 === 0 ? 8 : 0;
    const close = base + i * 0.5 + 4 * Math.sin(i / 4) + push;
    return {
      timestamp: T0 + i * spacing,
      open: close - 1 - push,
      high: close + 1.5,
      low: close - 2 - push,
      close,
      volume: i % 25 === 0 ? 400 : 100,
      dateStr: "",
    };
  });
}

describe("model inputs", () => {
  it("reads all six from the candles, price-based ones in percent", () => {
    const bars = toLabBars(candles(60));
    const f = metaFeatures(bars, 50);
    const b = bars[50];
    expect(f).toHaveLength(6);
    expect(f[0]).toBeCloseTo((b.atr! / b.close) * 100, 6);
    expect(f[1]).toBeCloseTo(Math.min(400 / ((400 + 9 * 100) / 10) / 5, 1), 6); // candle 50 is a push
    expect(f[2]).toBeCloseTo(b.rsi! / 100, 6);
    expect(f[3]).toBeCloseTo(((b.close - b.vwap!) / b.vwap!) * 100, 6);
    expect(f[4]).toBeCloseTo(new Date(b.timestampMs! + FIVE).getUTCHours() / 24, 6);
    expect(f[5]).toBeCloseTo(((b.close - bars[30].close) / bars[30].close) * 100, 6);
    expect(META_FEATURE_VERSION).toBe(2);
  });
});

describe("Lab replay on 5-minute candles", () => {
  const bars = toLabBars(candles(400));

  it("finds candle spacing and knows no hourly trend until enough hours have passed", () => {
    expect(candleSpacingMs(candles(10).map((c) => c.timestamp))).toBe(FIVE);
    const regimeAt = hourlyRegimeLookup(bars);
    expect(regimeAt(T0 + 2 * 60 * 60 * 1000)).toBe("neutral");
    const HOUR = 60 * 60 * 1000;
    expect(regimeAt(T0 + 30 * HOUR)).toBe("neutral"); // 30 hours closed: the 30th is index 29
    expect(regimeAt(T0 + 33 * HOUR)).not.toBe("neutral");
  });

  it("trades the tuned breakout and settles each trade within 30 minutes, after costs", () => {
    const trades = simulateTunedBreakout("SOL/INR", bars, {
      slMultiplier: 1.4, tpMultiplier: 2.8, volSurgeThreshold: 1.5, rsiThreshold: 101, minConfidence: 0,
    });
    expect(trades.length).toBeGreaterThan(3);
    for (const t of trades) {
      const held = Date.parse(t.exitTime.replace(" ", "T") + ":00Z") - Date.parse(t.entryTime.replace(" ", "T") + ":00Z");
      expect(held).toBeLessThanOrEqual(35 * 60 * 1000);
      const raw = ((t.direction === "LONG" ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice) / t.entryPrice) * 100;
      expect(t.pnlPercent).toBeCloseTo(raw - LAB_COST_PCT, 2);
      expect(t.features).toHaveLength(6);
    }
  });

  it("replays the live trader panel for training samples", () => {
    const samples = replayPanel("SOL/INR", bars);
    expect(samples.length).toBeGreaterThan(10);
    for (const s of samples) {
      expect(s.features).toHaveLength(6);
      expect(typeof s.win).toBe("boolean");
    }
  });

  it("refuses candles that aren't 5 minutes apart", async () => {
    await expect(runRealDataWalkForward(candles(300, 60 * 60 * 1000), "SOL/INR")).rejects.toThrow(/5-minute candles.*60 minutes apart/);
  });
});

describe("history download", () => {
  it("asks Binance for the USDT pair and pages back past 1,000 candles", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const end = /endTime=(\d+)/.exec(url)?.[1];
      const last = end ? Number(end) + 1 - FIVE : T0 + 2000 * FIVE;
      const n = Number(/limit=(\d+)/.exec(url)![1]);
      const rows = Array.from({ length: n }, (_, k) => {
        const t = last - (n - 1 - k) * FIVE;
        return [t, "1", "2", "0.5", "1.5", "10"];
      });
      return new Response(JSON.stringify(rows));
    });
    const out = await fetchRealHistoricalCandles("BTC/INR", "5m", 1500, "BINANCE");
    expect(urls[0]).toContain("symbol=BTCUSDT&interval=5m&limit=1000");
    expect(urls[1]).toMatch(/limit=500&endTime=\d+/);
    expect(out).toHaveLength(1500);
    expect(out[0].timestamp).toBeLessThan(out[1499].timestamp);
    expect(out.every((c) => !c.isSynthetic)).toBe(true);
  });
});

describe("online learning", () => {
  const setup: any = { symbol: "SOL/INR", name: "T", family: "trend_following", direction: "LONG", entryPrice: 100, stopLoss: 99, takeProfit: 102 };
  it("learns from finished intraday setups with recorded inputs from the last 30 days", () => {
    const now = T0 + 40 * 24 * 60 * 60 * 1000;
    const done = (signalTime: number, r: number, extra = {}) => ({
      ...shadowFromSetup(setup, "proposed", signalTime, { confidence: 0.5, scorer: "heuristic", features: [1, 0.2, 0.5, 0.1, 0.5, 0.3] }), status: "target" as const, r, ...extra,
    });
    const set = onlineTrainingSet(
      [
        done(now - 1000, 1.5),
        done(now - 2000, -1),
        done(now - 31 * 24 * 60 * 60 * 1000, 1), // too old
        done(now - 3000, 1, { features: undefined }), // no inputs recorded
        done(now - 4000, 1, { horizon: "swing" }),
        { ...shadowFromSetup(setup, "proposed", now - 5000, { confidence: 0.5, scorer: "heuristic", features: [1, 1, 1, 1, 1, 1] }) }, // still open
      ],
      now
    );
    expect(set.labels).toEqual([1, 0]);
    expect(set.features).toHaveLength(2);
    expect(MIN_ONLINE_SAMPLES).toBeGreaterThan(50);
  });
});

describe("prices of cheap coins", () => {
  it("keep their stops and targets instead of rounding to zero", () => {
    expect(roundPrice(0.00123456, 0.00125)).toBe(0.0012346); // 5 significant digits
    expect(roundPrice(12.345678, 12.3)).toBe(12.3457);
    expect(roundPrice(5_000_000.456, 5_000_000)).toBe(5_000_000.46);
    const cheap = decorateBarsWithIndicators(
      candles(40, FIVE, 1).map((c) => ({ ...c, open: c.open / 1000, high: c.high / 1000, low: c.low / 1000, close: c.close / 1000, time: "", timestampMs: c.timestamp }))
    ) as MarketBar[];
    const setup = buildBreakoutSetup(
      { symbol: "PEPE/INR", timeframe: "5m", bars: cheap, regime: "trending_bullish", eventWindowActive: false },
      { idSuffix: "t", name: "t", volSurgeThreshold: 1, stopAtrMult: 1.4, stopPriceFloorPct: 0.0025, targetAtrMult: 2.8, targetStopMultFloor: 1, baseProbability: 0.5 }
    )!;
    expect(setup.stopLoss).toBeGreaterThan(0);
    expect(Math.abs(setup.entryPrice - setup.stopLoss)).toBeGreaterThan(0);
    expect(Math.abs(setup.takeProfit - setup.entryPrice)).toBeGreaterThan(Math.abs(setup.entryPrice - setup.stopLoss));
  });
});
