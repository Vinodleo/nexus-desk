import { describe, expect, it } from "vitest";
import { generateInitialExperienceDatabase, retrieveSimilarExperiences } from "../../src/services/experienceMemory";
import { generateInitialBars, getSymbolConfig } from "../../src/services/marketDataService";
import {
  isBuiltOnSyntheticPrices,
  isSeededExperience,
  seededShare,
  syntheticBarShare,
} from "../../src/services/dataProvenance";
import { computeLearningStats, MIN_REAL_TRADES } from "../../src/services/learningStats";
import type { ExperienceVector, MarketBar, StrategySetup } from "../../src/types";

const bar = (isSynthetic?: boolean): MarketBar => ({ time: "", open: 1, high: 1, low: 1, close: 1, volume: 1, isSynthetic });

describe("price provenance", () => {
  it("measures the generated share of a bar series", () => {
    expect(syntheticBarShare([bar(), bar(), bar(true), bar(true)])).toBe(0.5);
    expect(syntheticBarShare([bar(), bar()])).toBe(0);
    expect(syntheticBarShare([])).toBe(1); // no data is not real data
  });

  it("flags every bar the generators produce", () => {
    const bars = generateInitialBars(getSymbolConfig("BTC/INR"), 20);
    expect(bars.every((b) => b.isSynthetic)).toBe(true);
  });

  it("gates on any generated share", () => {
    expect(isBuiltOnSyntheticPrices({ dataQuality: { syntheticBarShare: 0.01, seededExperienceShare: 0, simulatedOrderBook: true } })).toBe(true);
    expect(isBuiltOnSyntheticPrices({ dataQuality: { syntheticBarShare: 0, seededExperienceShare: 1, simulatedOrderBook: true } })).toBe(false);
    expect(isBuiltOnSyntheticPrices({})).toBe(false);
  });
});

describe("experience provenance", () => {
  it("recognises seeded examples by flag and by legacy id, and real trades by exp-live ids", () => {
    expect(isSeededExperience({ id: "exp-17", isSeeded: undefined })).toBe(true); // saved by an older build
    expect(isSeededExperience({ id: "anything", isSeeded: true })).toBe(true);
    expect(isSeededExperience({ id: "exp-live-1790000000000" })).toBe(false);
  });

  it("flags the whole starter bank", () => {
    const bank = generateInitialExperienceDatabase();
    expect(bank).toHaveLength(420);
    expect(seededShare(bank)).toBe(1);
  });

  it("reports how much of a k-NN win rate comes from seeded examples", () => {
    const bank = generateInitialExperienceDatabase();
    const setup = {
      family: "trend_following",
      features: { adx: 30, rsi: 55, volumeSurgeRatio: 1.5, vwapDistancePercent: 0.2 },
    } as unknown as StrategySetup;
    const seededOnly = retrieveSimilarExperiences(setup, "trending_bullish", bank);
    expect(seededOnly.seededShare).toBe(1);

    // Real trades identical to five of the nearest seeded ones must land in the
    // neighbourhood. (The bank is random, so copying arbitrary entries didn't.)
    const realTwins: ExperienceVector[] = seededOnly.neighbors
      .slice(0, 5)
      .map((e, i) => ({ ...e, id: `exp-live-${i}`, isSeeded: undefined }));
    const mixed = retrieveSimilarExperiences(setup, "trending_bullish", [...realTwins, ...bank]);
    expect(mixed.seededShare).toBeGreaterThan(0);
    expect(mixed.seededShare).toBeLessThan(1);
  });
});

describe("computeLearningStats", () => {
  const realTrade = (i: number, win: boolean, p = 0.6, pnl = win ? 100 : -80): ExperienceVector =>
    ({ id: `exp-live-${i}`, outcome: win ? "WIN" : "LOSS", metaConfidence: p, pnl } as ExperienceVector);

  it("reports nothing until there are enough real trades, however big the seeded bank", () => {
    const bank = [realTrade(1, true), ...generateInitialExperienceDatabase()];
    const s = computeLearningStats(bank);
    expect(s).toMatchObject({ realCount: 1, seededCount: 420, enough: false, winRatePct: null, brierScore: null });
  });

  it("measures real trades only: win rates, Brier score and drawdown", () => {
    // Oldest -> newest: 5 losses then 5 wins. Stored newest-first.
    const chronological = [
      ...Array.from({ length: 5 }, (_, i) => realTrade(i, false, 0.6)),
      ...Array.from({ length: 5 }, (_, i) => realTrade(5 + i, true, 0.6)),
    ];
    const stats = computeLearningStats([...chronological].reverse().concat(generateInitialExperienceDatabase()));
    expect(stats.realCount).toBe(MIN_REAL_TRADES);
    expect(stats.winRatePct).toBe(50);
    expect(stats.earlyWinRatePct).toBe(0);
    expect(stats.recentWinRatePct).toBe(100);
    // 5 losses at p=.6 -> .36 each, 5 wins at p=.6 -> .16 each => mean .26
    expect(stats.brierScore).toBe(0.26);
    // 5 x -80 from 100,000 = 99,600 trough => 0.4% drawdown
    expect(stats.maxDrawdownPct).toBe(0.4);
  });
});
