// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIN_TEST_SAMPLES,
  checkAndRunOnlineLearning,
  judgeChallenger,
  topHalfR,
  type RetrainDeps,
} from "../../src/services/onlineLearningService";
import { loadStoredPromotedLabModel, saveStoredPromotedLabModel } from "../../src/services/storagePersistenceService";
import { META_FEATURE_VERSION } from "../../src/services/metaFeatures";
import { shadowFromSetup, type ShadowSignal } from "../../src/services/shadowTracker";
import type { PromotedLabModel } from "../../src/types";

// A retrained model goes live only if, on the latest week it didn't learn
// from, the setups it rates best earned more than the live model's picks
// and than all of them together.

vi.spyOn(console, "log").mockImplementation(() => {});
beforeEach(() => localStorage.clear());

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-01T06:00:00Z");

describe("judging a retrained model", () => {
  it("scores a model by what the half it rates best earned", () => {
    expect(topHalfR([0.9, 0.1, 0.8, 0.2], [2, -1, 1, -1])).toBe(1.5);
    expect(topHalfR([0.1, 0.9, 0.2, 0.8], [2, -1, 1, -1])).toBe(-1);
  });

  it("switches only to one that picks better than the model in use and than taking everything", () => {
    const r = [2, -1, 1, -1];
    const good = [0.9, 0.1, 0.8, 0.2];
    const bad = [0.1, 0.9, 0.2, 0.8];
    expect(judgeChallenger(r, good, bad)).toMatchObject({ challengerR: 1.5, championR: -1, allR: 0.25, switched: true });
    expect(judgeChallenger(r, bad, good).switched).toBe(false);
    expect(judgeChallenger(r, good, good).switched).toBe(false); // no better: keep what's there
    expect(judgeChallenger(r, good, null).switched).toBe(true);
    expect(judgeChallenger(r, bad, null).switched).toBe(false); // worse than taking everything
  });
});

describe("the daily retrain", () => {
  /** A finished setup on its own coin: a +1.5R winner or a −1R loser, with a model input saying which. */
  const done = (k: number, signalTime: number, win: boolean): ShadowSignal => ({
    ...shadowFromSetup(
      { symbol: `C${k}/INR`, name: "Marcus Swing Trend", family: "trend_following", direction: "LONG", entryPrice: 100, stopLoss: 99, takeProfit: 102 } as any,
      "proposed",
      signalTime,
      { features: [win ? 1 : 0, 0.2, 0.5, 0.1, 0.5, 0.3] }
    ),
    status: win ? "target" : "stop",
    exitPrice: win ? 101.6 : 99,
    r: win ? 1.5 : -1,
    resolvedAt: signalTime + HOUR,
  });
  const older = Array.from({ length: 150 }, (_, k) => done(k, NOW - 8 * DAY - k * HOUR, k % 2 === 0));
  const lastWeek = (n: number) => Array.from({ length: n }, (_, k) => done(1000 + k, NOW - DAY - k * HOUR, k % 3 === 0));

  // Stand-in models: one rates winners high, the other losers.
  const picksWinners = { name: "good" } as any;
  const picksLosers = { name: "bad" } as any;
  const deps = (trained: any, live: any): RetrainDeps & { saveLive: ReturnType<typeof vi.fn>; train: ReturnType<typeof vi.fn> } => ({
    train: vi.fn(async () => trained),
    loadLive: async () => live,
    predict: (model: any, features: number[][]) => features.map((f) => (model.name === "good" ? f[0] : 1 - f[0])),
    saveLive: vi.fn(async () => undefined),
  });
  const inUse: PromotedLabModel = {
    promotedAt: "2026-09-20T00:00:00.000Z", datasetName: "Lab", accuracyPct: 55, winRatePct: 55, sharpeRatio: 0, totalCandlesEvaluated: 0,
    distilledRulesCount: 0, distilledLessons: [], hasTrainedModel: true, featureVersion: META_FEATURE_VERSION,
  };

  it("learns from the older weeks and puts a better model live", async () => {
    const d = deps(picksWinners, null);
    expect(await checkAndRunOnlineLearning([...older, ...lastWeek(40)], NOW, d)).toBe(true);
    // Trained on the 150 older setups only; the latest week was held back.
    expect(d.train.mock.calls[0][0]).toHaveLength(150);
    expect(d.saveLive).toHaveBeenCalledWith(picksWinners);
    const saved = loadStoredPromotedLabModel()!;
    expect(saved.hasTrainedModel).toBe(true);
    expect(saved.distilledLessons.at(-1)!.rule).toMatch(/on the latest week's 40 it hadn't seen, the half it rated best earned \+0\.75R each, against −0\.13R for all of them\. Switched to it\./);
  });

  it("keeps the model in use when the retrained one picks worse, and says so", async () => {
    saveStoredPromotedLabModel(inUse);
    const d = deps(picksLosers, picksWinners);
    expect(await checkAndRunOnlineLearning([...older, ...lastWeek(40)], NOW, d)).toBe(false);
    expect(d.saveLive).not.toHaveBeenCalled();
    const saved = loadStoredPromotedLabModel()!;
    expect(saved.promotedAt).toBe(inUse.promotedAt);
    expect(saved.distilledLessons.at(-1)!.rule).toMatch(/for the model in use and .* for all of them\. Kept the model in use\./);
    // Checked once a day.
    const again = deps(picksWinners, picksWinners);
    expect(await checkAndRunOnlineLearning([...older, ...lastWeek(40)], NOW + HOUR, again)).toBe(false);
    expect(again.train).not.toHaveBeenCalled();
  });

  it("waits until there's a week to test on", async () => {
    const d = deps(picksWinners, null);
    expect(await checkAndRunOnlineLearning([...older, ...lastWeek(MIN_TEST_SAMPLES - 1)], NOW, d)).toBe(false);
    expect(d.train).not.toHaveBeenCalled();
  });
});
