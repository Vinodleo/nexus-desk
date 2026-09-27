import { describe, expect, it } from "vitest";
import { oneShadowAtATime, shadowFromSetup, type ShadowSignal } from "../../src/services/shadowTracker";
import { buildCalibrator, HEURISTIC_SCORE_VERSION } from "../../src/services/calibration";
import { conditionBreakdown } from "../../src/services/conditionStats";
import { onlineTrainingSet } from "../../src/services/onlineLearningService";
import { experiencesFromShadows } from "../../src/services/experienceMemory";

// A setup stays valid for several candles and is followed again on each, so
// one price move used to be counted many times in what the desk learns from.
// Now each trader's move in each market counts once.

const FIVE = 5 * 60 * 1000;
const T0 = Math.floor(1_790_000_000_000 / FIVE) * FIVE;
const setup: any = {
  symbol: "SOL/INR", name: "Marcus Swing Trend", family: "trend_following", direction: "LONG", entryPrice: 100, stopLoss: 99, takeProfit: 102,
  features: { emaAlignment: true, volumeSurgeRatio: 1.5, vwapDistancePercent: 0.2, adx: 30, rsi: 58, atr: 1 },
};

/** One move: the setup followed on `n` candles in a row, all resolving 40 minutes after the first appeared. */
const move = (start: number, n = 6, over: Partial<ShadowSignal> = {}, s = setup): ShadowSignal[] =>
  Array.from({ length: n }, (_, k) => ({
    ...shadowFromSetup(s, "proposed", start + k * FIVE, {
      confidence: 0.6, scoreVersion: HEURISTIC_SCORE_VERSION, scorer: "heuristic", features: [1, 0.2, 0.5, 0.1, 0.5, 0.3], regime: "trending_bullish",
    }),
    status: "target" as const, r: 1.9, exitPrice: 102, resolvedAt: start + 8 * FIVE,
    ...over,
  }));

describe("followed setups, one at a time", () => {
  it("count a trader's move in a market once, the first time it appeared", () => {
    const first = move(T0);
    const second = move(T0 + 8 * FIVE); // starts as the first resolves
    const kept = oneShadowAtATime([...first, ...second]);
    expect(kept.map((s) => s.signalTime)).toEqual([T0, T0 + 8 * FIVE]);
  });

  it("count other traders and other markets on their own", () => {
    const other = move(T0, 3, {}, { ...setup, name: "Priya Momentum Scalp" });
    const eth = move(T0, 3, {}, { ...setup, symbol: "ETH/INR" });
    expect(oneShadowAtATime([...move(T0, 3), ...other, ...eth])).toHaveLength(3);
  });

  it("hold a setup's place while it's still being followed, and keep the list's order", () => {
    const open = { ...shadowFromSetup(setup, "proposed", T0, { confidence: 0.6 }) };
    expect(oneShadowAtATime([...move(T0 + FIVE, 3), open])).toEqual([open]);
    const newestFirst = [...move(T0 + 8 * FIVE, 1), ...move(T0, 1)];
    expect(oneShadowAtATime(newestFirst)).toEqual(newestFirst);
  });
});

describe("what the desk learns from", () => {
  // Two moves of six candles each: two lessons, not twelve.
  const shadows = [...move(T0), ...move(T0 + 8 * FIVE)];
  const now = T0 + 24 * 60 * 60 * 1000;

  it("counts each move once in the win-chance calibration, 'When setups win', the retraining and the trade memory", () => {
    expect(buildCalibrator(shadows).samples).toBe(2);
    expect(conditionBreakdown(shadows).setups).toBe(2);
    expect(onlineTrainingSet(shadows, now).labels).toEqual([1, 1]);
    expect(experiencesFromShadows(shadows)).toHaveLength(2);
  });
});
