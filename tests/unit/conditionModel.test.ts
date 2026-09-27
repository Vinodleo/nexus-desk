// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRIOR_SETUPS, scoreWithConditions, trainConditionModel, type ConditionModel } from "../../src/services/conditionModel";
import { shadowFromSetup, type ShadowSignal } from "../../src/services/shadowTracker";
import { _resetScannedCandles, scanAllMarkets } from "../../src/services/marketScannerService";
import type { MarketBar } from "../../src/types";

// The scoring table: what setups like this one scored, by trader in each
// market and the conditions they appeared in, each condition's effect pulled
// toward none unless many setups back it.

vi.spyOn(console, "warn").mockImplementation(() => {});

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-09-28T04:00:00Z");
const setupFor = (name: string, symbol = "SOL/INR"): any => ({
  symbol, name, family: "trend_following", direction: "LONG", entryPrice: 100, stopLoss: 99, takeProfit: 102,
  features: { emaAlignment: true, volumeSurgeRatio: 1.2, vwapDistancePercent: 0.1, adx: 25, rsi: 50, atr: 1 },
});

let k = 0;
/** A finished setup, an hour apart from the last so none overlap: at its target (1) or stopped (0). */
function done(name: string, hit: boolean, over: { btc?: number; rsi?: number; symbol?: string } = {}): ShadowSignal {
  const t = T0 + k++ * HOUR;
  const setup = setupFor(name, over.symbol);
  if (over.rsi !== undefined) setup.features = { ...setup.features, rsi: over.rsi };
  return {
    ...shadowFromSetup(setup, "proposed", t, { regime: "trending_bullish", btcChange1hPct: over.btc ?? 0 }),
    status: hit ? "target" : "stop", exitPrice: hit ? 102 : 99, r: hit ? 1.9 : -1.1, resolvedAt: t + HOUR / 2,
  };
}
beforeEach(() => (k = 0));

describe("the scoring table", () => {
  it("scores each trader in each market by what their setups did", () => {
    const model = trainConditionModel([
      ...Array.from({ length: 40 }, () => done("Marcus Swing Trend", true)),
      ...Array.from({ length: 40 }, () => done("Priya Momentum Scalp", false)),
    ]);
    const marcus = scoreWithConditions(model, done("Marcus Swing Trend", true));
    const priya = scoreWithConditions(model, done("Priya Momentum Scalp", true));
    expect(marcus.score).toBeGreaterThan(0.8);
    expect(priya.score).toBeLessThan(0.2);
    expect(marcus.samples).toBe(40);
    // The same trader in another market has no record there yet.
    expect(scoreWithConditions(model, done("Marcus Swing Trend", true, { symbol: "SBIN" })).samples).toBe(0);
  });

  it("learns what a condition does across traders", () => {
    // Every trader wins with Bitcoin rising and loses with it falling.
    const model = trainConditionModel(
      ["Marcus Swing Trend", "Priya Momentum Scalp"].flatMap((name) => [
        ...Array.from({ length: 30 }, () => done(name, true, { btc: 1 })),
        ...Array.from({ length: 30 }, () => done(name, false, { btc: -1 })),
      ])
    );
    const rising = scoreWithConditions(model, done("Marcus Swing Trend", true, { btc: 1 })).score;
    const falling = scoreWithConditions(model, done("Marcus Swing Trend", true, { btc: -1 })).score;
    expect(rising - falling).toBeGreaterThan(0.6);
  });

  it("barely moves on a thin row, and counts each move once", () => {
    const common = Array.from({ length: 60 }, (_, i) => done("Marcus Swing Trend", i % 2 === 0));
    // One overbought setup that hit its target: one setup can't say much.
    const model = trainConditionModel([...common, done("Marcus Swing Trend", true, { rsi: 80 })]);
    expect(model.effects.rsi["Overbought (70 or more)"]).toBeLessThan(1 / (1 + PRIOR_SETUPS));
    // The same setup followed on three candles in a row, before it resolved, is one lesson.
    const t = T0 + 500 * HOUR;
    const repeats = [0, 1, 2].map((c) => ({ ...done("Marcus Swing Trend", true), signalTime: t + c * 5 * 60_000, id: `r${c}`, resolvedAt: t + HOUR }));
    expect(trainConditionModel(repeats).samples).toBe(1);
  });
});

describe("the scanner", () => {
  beforeEach(() => _resetScannedCandles());
  const FIVE = 5 * 60 * 1000;
  const lastOpen = Math.floor(Date.now() / FIVE) * FIVE - FIVE;
  const trend: MarketBar[] = Array.from({ length: 150 }, (_, i) => {
    const c = 10000 + i * 8;
    return { time: String(i), timestampMs: lastOpen - (149 - i) * FIVE, open: c - 2, high: c + 4, low: c - 4, close: c, volume: 100 + i };
  });
  const scan = (conditionModel: ConditionModel) =>
    scanAllMarkets({
      activePositions: [], dailyRealizedPnl: 0, experiences: [], symbols: ["SOL/INR"], barsMap: { "SOL/INR": trend },
      failureState: {
        globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
        simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
      },
      conditionModel,
    });

  it("scores setups on what the table says similar setups did", async () => {
    const report = await scan({ base: 0.9, samples: 200, effects: {}, traderSetups: {} });
    const found = report.shadows.filter((s) => s.kind !== "against_trend");
    expect(found.length).toBeGreaterThan(0);
    // The table's score is what similar setups did, and no generated memory is involved.
    const p = report.newProposals[0];
    expect(p.metaScore.historicalWinRate).toBe(0.9);
    expect(p.dataQuality?.seededExperienceShare).toBe(0);
  });
});
