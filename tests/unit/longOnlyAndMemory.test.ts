// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetScannedCandles, scanAllMarkets } from "../../src/services/marketScannerService";
import { computeMetaLabelScore } from "../../src/services/metaLabeling";
import { experiencesFromShadows, retrieveSimilarExperiences } from "../../src/services/experienceMemory";
import { buildCalibrator, HEURISTIC_SCORE_VERSION } from "../../src/services/calibration";
import { shadowFromSetup, type ShadowSignal } from "../../src/services/shadowTracker";
import type { MarketBar, StrategySetup } from "../../src/types";

vi.spyOn(console, "warn").mockImplementation(() => {});

const FIVE = 5 * 60 * 1000;
const lastOpen = Math.floor(Date.now() / FIVE) * FIVE - FIVE;
const series = (step: number): MarketBar[] =>
  Array.from({ length: 150 }, (_, i) => {
    const c = 12000 + i * step;
    return { time: String(i), timestampMs: lastOpen - (149 - i) * FIVE, open: c - step / 4, high: c + 4, low: c - 4, close: c, volume: 100 + i };
  });
const options = (bars: MarketBar[]) => ({
  symbols: ["SOL/INR"],
  barsMap: { "SOL/INR": bars },
  activePositions: [],
  dailyRealizedPnl: 0,
  failureState: {
    globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
    simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
  },
});

describe("CoinDCX spot is long-only", () => {
  beforeEach(() => _resetScannedCandles());

  it("proposes no shorts on a falling coin, and follows them as 'can't short'", async () => {
    const report = await scanAllMarkets(options(series(-8)));
    expect(report.newProposals.filter((p) => p.setup.direction === "SHORT")).toEqual([]);
    expect(report.outcomes[0]).toEqual({ symbol: "SOL/INR", proposed: false, reason: "no_shorting" });
    const shorts = report.shadows.filter((s) => s.kind === "no_shorting");
    expect(shorts.length).toBeGreaterThan(0);
    expect(shorts.every((s) => s.direction === "SHORT")).toBe(true);
  });

  it("still proposes longs on a rising coin, recording what the memory needs", async () => {
    const report = await scanAllMarkets(options(series(8)));
    expect(report.outcomes[0]).toEqual({ symbol: "SOL/INR", proposed: true });
    const s = report.shadows.find((x) => x.kind === "proposed")!;
    expect(s.regime).toBeTruthy();
    expect(s.setupFeatures).toMatchObject({ rsi: expect.any(Number), adx: expect.any(Number) });
    expect(s.scoreVersion).toBe(HEURISTIC_SCORE_VERSION);
  });
});

const setup = {
  id: "s", name: "Trend", family: "trend_following", direction: "LONG", symbol: "SOL/INR", timeframe: "5m",
  entryPrice: 100, stopLoss: 99, takeProfit: 102, riskRewardRatio: 2, baseProbability: 0.6, qualifies: true,
  features: { emaAlignment: true, volumeSurgeRatio: 1.5, vwapDistancePercent: 0.2, adx: 30, rsi: 58, atr: 1 },
} as StrategySetup;

describe("the score without generated memory", () => {
  it("uses the trader's own estimate when there are no similar past setups", () => {
    const none = computeMetaLabelScore({ setup, regime: "ranging_wide", empiricalWinRate: 0.5, sampleCount: 0, similarityScore: 0 });
    expect(none.confidence).toBeCloseTo(0.6, 3); // baseProbability; no regime adjustment for this family/regime
  });

  it("lets similar past setups count fully only with 15 close matches", () => {
    const full = computeMetaLabelScore({ setup, regime: "ranging_wide", empiricalWinRate: 0.2, sampleCount: 15, similarityScore: 0.8 });
    expect(full.confidence).toBeCloseTo(0.2 * 0.55 + 0.6 * 0.45, 3);
    const few = computeMetaLabelScore({ setup, regime: "ranging_wide", empiricalWinRate: 0.2, sampleCount: 3, similarityScore: 0.8 });
    const w = 0.55 * (3 / 15);
    expect(few.confidence).toBeCloseTo(0.2 * w + 0.6 * (1 - w), 3);
  });
});

describe("memory from real results", () => {
  const FIVE_MIN = 5 * 60 * 1000;
  const T0 = Math.floor(1_790_000_000_000 / FIVE_MIN) * FIVE_MIN;
  const done = (i: number, r: number, exit: number, extra: Partial<ShadowSignal> = {}): ShadowSignal => ({
    ...shadowFromSetup(setup, i % 2 ? "low_confidence" : "proposed", T0 + i * FIVE_MIN, { confidence: 0.55, regime: "trending_bullish" }),
    status: r > 0 ? "target" : "stop",
    r,
    exitPrice: exit,
    ...extra,
  });

  it("turns finished tracked setups into memory, wins after fees", () => {
    const memory = experiencesFromShadows([
      done(0, 1.9, 102),
      done(1, -1.1, 99),
      { ...shadowFromSetup(setup, "proposed", T0, { regime: "trending_bullish" }) }, // still open
      done(3, 1.9, 102, { setupFeatures: undefined }), // older record without readings
    ]);
    expect(memory.map((m) => [m.outcome, m.decision])).toEqual([["WIN", "TRADE"], ["LOSS", "NO_TRADE"]]);
    expect(memory[0]).toMatchObject({ family: "trend_following", regime: "trending_bullish" });
    expect(memory[0].isSeeded).toBeFalsy();
    expect(memory[0].features).toMatchObject({ adx: 30, rsi: 58, volumeSurgeRatio: 1.5, vwapDist: 0.2 });
    // The scanner's retrieval finds them, and none are generated.
    const found = retrieveSimilarExperiences(setup, "trending_bullish", memory, 15);
    expect(found).toMatchObject({ sampleCount: 2, empiricalWinRate: 0.5, seededShare: 0 });
    // A short's result isn't memory for a long.
    const shortMemory = memory.map((m) => ({ ...m, direction: "SHORT" as const }));
    expect(retrieveSimilarExperiences(setup, "trending_bullish", shortMemory, 15).sampleCount).toBe(0);
  });
});

describe("calibration and the score version", () => {
  it("ignores setups scored with the old formula", () => {
    const old = Array.from({ length: 50 }, (_, i) => ({ ...shadowFromSetup(setup, "proposed", i, { confidence: 0.6 }), status: "target" as const, exitPrice: 102 }));
    expect(buildCalibrator(old).samples).toBe(0);
    const current = old.map((s) => ({ ...s, scoreVersion: HEURISTIC_SCORE_VERSION }));
    expect(buildCalibrator(current).samples).toBe(50);
  });
});
