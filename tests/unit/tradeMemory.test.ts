import { describe, expect, it } from "vitest";
import type { ExperienceVector, HistoricalTrade } from "../../src/types";
import type { ShadowSignal } from "../../src/services/shadowTracker";
import { READINGS_UNKNOWN, experienceFromTrade, retrieveSimilarExperiences, withTradeExperiences } from "../../src/services/experienceMemory";
import { computeLearningStats } from "../../src/services/learningStats";

// Learning's "your real trades": every closed trade, whoever closed it, with
// the market's readings from when its setup was found.

const at = (h: number, m = 0) => new Date(2026, 8, 25, h, m).getTime();

function trade(id: string, pnl: number, over: Partial<HistoricalTrade> = {}): HistoricalTrade {
  return {
    id, symbol: "SOL/INR", direction: "LONG", setupName: "Diego Aggressive Breakout", entryPrice: 100, exitPrice: 98, quantity: 1,
    moneyPlaced: 100, feesPaid: 0.2, realizedPnl: pnl, realizedPnlPercent: pnl, isWin: pnl > 0, exitReason: pnl > 0 ? "TAKE_PROFIT" : "STOP_LOSS",
    openedAt: "", closedAt: "", openedAtMs: at(18, 5), closedAtMs: at(19, 34), ...over,
  };
}

const shadow = (over: Partial<ShadowSignal> = {}): ShadowSignal => ({
  id: "s1", symbol: "SOL/INR", direction: "LONG", setupName: "Diego Aggressive Breakout", family: "breakout_confirmation",
  horizon: "intraday", kind: "proposed", confidence: 0.61, regime: "trending_bullish",
  setupFeatures: { adx: 31.2, rsi: 58.4, volumeSurgeRatio: 2.3, vwapDistancePercent: 0.8 },
  entryPrice: 100, stopLoss: 98, takeProfit: 104, signalTime: at(18, 0), expiresAt: at(22, 0), status: "open", ...over,
} as ShadowSignal);

describe("a closed trade in the memory", () => {
  it("carries the readings from when its setup was found, not placeholders", () => {
    const e = experienceFromTrade(trade("t1", -273.95), [shadow(), shadow({ id: "old", signalTime: at(12), setupFeatures: { adx: 1, rsi: 1, volumeSurgeRatio: 1, vwapDistancePercent: 1 } })]);
    expect(e).toMatchObject({
      id: "exp-trade-t1", outcome: "LOSS", pnl: -273.95, regime: "trending_bullish", family: "breakout_confirmation", direction: "LONG",
      features: { adx: 31.2, rsi: 58.4, volumeSurgeRatio: 2.3, vwapDist: 0.8 }, metaConfidence: 0.61,
    });
    expect(e.tags).not.toContain(READINGS_UNKNOWN);
  });

  it("still counts without a record of its setup, but isn't matched on readings it doesn't have", () => {
    const e = experienceFromTrade(trade("t2", 120, { setupName: "Sofia Range Scalp" }), [shadow()]);
    expect(e.tags).toContain(READINGS_UNKNOWN);
    expect(e.family).toBe("mean_reversion");
    const setup = { family: "mean_reversion", direction: "LONG", features: { adx: 0, rsi: 50, volumeSurgeRatio: 1, vwapDistancePercent: 0 } } as any;
    expect(retrieveSimilarExperiences(setup, "ranging_tight", [e]).sampleCount).toBe(0);
  });
});

describe("the memory", () => {
  it("takes in every closed trade once, including ones the server closed, and replaces the old placeholder memories", () => {
    const placeholder = { id: "exp-live-1", isSeeded: false, outcome: "LOSS", tags: [] } as unknown as ExperienceVector;
    const seeded = { id: "seed-1", isSeeded: true, outcome: "WIN", tags: [] } as unknown as ExperienceVector;
    const trades = Array.from({ length: 11 }, (_, i) => trade(`t${i}`, i % 3 === 0 ? 50 : -50, { openedByServer: i % 2 === 0 }));
    const memory = withTradeExperiences([placeholder, seeded], trades, [shadow()]);
    expect(memory.map((e) => e.id)).not.toContain("exp-live-1");
    expect(memory.filter((e) => e.id.startsWith("exp-trade-"))).toHaveLength(11);
    expect(computeLearningStats(memory).realCount).toBe(11);
    // Nothing new: the same array back.
    expect(withTradeExperiences(memory, trades, [])).toBe(memory);
  });
});
