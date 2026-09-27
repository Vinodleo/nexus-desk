import { describe, expect, it } from "vitest";
import { scoreFromR } from "../../src/services/calibration";
import { experienceFromTrade, experiencesFromShadows, retrieveSimilarExperiences } from "../../src/services/experienceMemory";
import { shadowFromSetup, type ShadowSignal } from "../../src/services/shadowTracker";
import type { ExperienceVector, HistoricalTrade, StrategySetup } from "../../src/types";

// What the desk learns from a setup is how far it got toward its target (the
// calibration's win scale), not just whether it ended ahead: a +0.1R scrape
// and a +2R target aren't the same "win".

const FIVE = 5 * 60 * 1000;
const T0 = Math.floor(1_790_000_000_000 / FIVE) * FIVE;
// Entry 100, stop 99 (1R), target 102 (2R).
const setup = {
  id: "s", name: "Marcus Swing Trend", family: "trend_following", direction: "LONG", symbol: "SOL/INR", timeframe: "5m",
  entryPrice: 100, stopLoss: 99, takeProfit: 102, riskRewardRatio: 2, baseProbability: 0.6, qualifies: true,
  features: { emaAlignment: true, volumeSurgeRatio: 1.5, vwapDistancePercent: 0.2, adx: 30, rsi: 58, atr: 1 },
} as StrategySetup;

/** A followed setup that closed at `exit`, on a coin of its own so none overlap. */
const followed = (exit: number, k: number): ShadowSignal => ({
  ...shadowFromSetup({ ...setup, symbol: `C${k}/INR` }, "proposed", T0 + k * FIVE, {
    confidence: 0.6, features: [1, 0.2, 0.5, 0.1, 0.5, 0.3], regime: "trending_bullish",
  }),
  status: exit >= 102 ? "target" : exit <= 99 ? "stop" : "expired",
  exitPrice: exit,
  r: (exit - 100 - 0.1) / 1,
  resolvedAt: T0 + (k + 1) * FIVE,
});

describe("a result on the win scale", () => {
  it("is 1 at the target, 0 at the stop, and in between by how far it got", () => {
    expect(scoreFromR(2, 2)).toBe(1);
    expect(scoreFromR(-1, 2)).toBe(0);
    expect(scoreFromR(0.1, 2)).toBeCloseTo(1.1 / 3, 6);
  });
});

describe("the trade memory", () => {
  it("scores each followed setup by how far it got", () => {
    // +0.2 on the price (+0.1R after fees): a "win" that got a fifth of the way.
    const [scrape, stopped, target] = experiencesFromShadows([followed(100.2, 0), followed(99, 1), followed(102, 2)]);
    expect(scrape).toMatchObject({ outcome: "WIN", outcomeScore: expect.closeTo(1.2 / 3, 3) });
    expect(stopped.outcomeScore).toBe(0);
    expect(target.outcomeScore).toBe(1);
  });

  it("scores a closed trade by its result in R against its setup's target", () => {
    const shadows = [followed(102, 0)].map((s) => ({ ...s, symbol: "SOL/INR" }));
    const trade = {
      id: "t1", symbol: "SOL/INR", direction: "LONG", setupName: setup.name, entryPrice: 100, exitPrice: 100.5, quantity: 10,
      moneyPlaced: 1000, grossPnl: 5, realizedPnl: 4, realizedPnlPercent: 0.4, isWin: true, exitReason: "TRAILING_STOP",
      openedAt: "", closedAt: "", openedAtMs: T0 + FIVE, closedAtMs: T0 + 3 * FIVE, riskAtOpen: 10,
    } as HistoricalTrade;
    // +0.5R on a 2R target: (0.5 + 1) / 3.
    expect(experienceFromTrade(trade, shadows).outcomeScore).toBeCloseTo(0.5, 6);
    expect(experienceFromTrade({ ...trade, riskAtOpen: undefined }, shadows).outcomeScore).toBeUndefined();
  });

  it("judges similar setups by how far they got, not how many ended ahead", () => {
    const memory = experiencesFromShadows([followed(100.2, 0), followed(99, 1)]);
    // One scraped a small win, one stopped: that isn't a 50% record.
    const found = retrieveSimilarExperiences(setup, "trending_bullish", memory, 15);
    expect(found.sampleCount).toBe(2);
    expect(found.empiricalWinRate).toBeCloseTo(1.2 / 3 / 2, 2);
    // Older memories without the score still count a win as 1.
    const legacy = memory.map(({ outcomeScore: _drop, ...m }) => m as ExperienceVector);
    expect(retrieveSimilarExperiences(setup, "trending_bullish", legacy, 15).empiricalWinRate).toBe(0.5);
  });
});
