// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketBar } from "../../src/types";

// The scanner feeds a Lab model only the inputs it was trained on: a model
// from before the inputs were aligned (no featureVersion) isn't loaded.

const loadMetaModel = vi.fn(async () => null);
vi.mock("../../src/services/mlService", () => ({
  loadMetaModel: () => loadMetaModel(),
  predictConfidenceBatch: vi.fn(() => []),
}));
vi.spyOn(console, "warn").mockImplementation(() => {});

const FIVE = 5 * 60 * 1000;
const lastOpen = Math.floor(Date.now() / FIVE) * FIVE - FIVE;
const trend: MarketBar[] = Array.from({ length: 150 }, (_, i) => {
  const c = 10000 + i * 8;
  return { time: String(i), timestampMs: lastOpen - (149 - i) * FIVE, open: c - 2, high: c + 4, low: c - 4, close: c, volume: 100 + i };
});
const options = {
  symbols: ["SOL/INR"],
  barsMap: { "SOL/INR": trend },
  activePositions: [],
  dailyRealizedPnl: 0,
  experiences: [],
  failureState: {
    globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
    simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
  },
};
const promote = (extra: object) =>
  localStorage.setItem(
    "nexus_agent_promoted_lab_model_inr_v4",
    JSON.stringify({
      promotedAt: "2026-09-20T00:00:00Z", datasetName: "Lab", accuracyPct: 60, winRatePct: 55, sharpeRatio: 1,
      totalCandlesEvaluated: 3000, distilledRulesCount: 0, distilledLessons: [], hasTrainedModel: true, ...extra,
    })
  );

describe("Lab model inputs", () => {
  beforeEach(async () => {
    loadMetaModel.mockClear();
    (await import("../../src/services/marketScannerService"))._resetScannedCandles();
  });

  it("leaves out a model trained on the old inputs", async () => {
    promote({});
    const { scanAllMarkets } = await import("../../src/services/marketScannerService");
    await scanAllMarkets(options);
    expect(loadMetaModel).not.toHaveBeenCalled();
  });

  it("uses a model trained on the current inputs, and records them on each shadow", async () => {
    promote({ featureVersion: 2 });
    const { scanAllMarkets } = await import("../../src/services/marketScannerService");
    const report = await scanAllMarkets(options);
    expect(loadMetaModel).toHaveBeenCalled();
    expect(report.shadows[0].features).toHaveLength(6);
  });
});
