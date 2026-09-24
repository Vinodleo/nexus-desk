// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_CALIBRATION_SAMPLES, buildCalibrator, outcomeScore, type Calibrator } from "../../src/services/calibration";
import { shadowFromSetup, type ShadowSignal } from "../../src/services/shadowTracker";
import { WinChanceCalibration } from "../../src/components/ledger/LedgerLearning";
import { _resetScannedCandles, scanAllMarkets } from "../../src/services/marketScannerService";
import type { MarketBar } from "../../src/types";

vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(cleanup);

const FIVE = 5 * 60 * 1000;
const T0 = Math.floor(1_790_000_000_000 / FIVE) * FIVE;
// 1R stop, 2R target.
const setup: any = { symbol: "SOL/INR", name: "Trend", family: "trend_following", direction: "LONG", entryPrice: 1000, stopLoss: 990, takeProfit: 1020 };

let n = 0;
function resolved(score: number, status: "target" | "stop" | "expired", exitPrice?: number, extra: Partial<ShadowSignal> = {}): ShadowSignal {
  const s = shadowFromSetup(setup, "proposed", T0 + n++ * FIVE, { confidence: score, scoreVersion: 2 });
  const exit = exitPrice ?? (status === "target" ? 1020 : status === "stop" ? 990 : 1000);
  return { ...s, status, exitPrice: exit, ...extra };
}

describe("scoring an outcome", () => {
  it("counts a target as 1, a stop as 0 and a timed-out trade part-way", () => {
    expect(outcomeScore(resolved(0.5, "target"))).toBe(1);
    expect(outcomeScore(resolved(0.5, "stop"))).toBe(0);
    // Closed at +0.5R on a 2R target: (0.5 + 1) / (2 + 1)
    expect(outcomeScore(resolved(0.5, "expired", 1005))).toBeCloseTo(0.5);
    expect(outcomeScore(shadowFromSetup(setup, "proposed", T0, { confidence: 0.5 }))).toBeNull(); // still open
  });
});

describe("building the calibrator", () => {
  // `wins` of `count` setups at `score` reached their target; the rest stopped out.
  const batch = (score: number, count: number, wins: number) =>
    Array.from({ length: count }, (_, i) => resolved(score, i < wins ? "target" : "stop"));

  it("keeps the raw score until enough setups have finished", () => {
    const cal = buildCalibrator(batch(0.62, MIN_CALIBRATION_SAMPLES - 1, 30));
    expect(cal.ready).toBe(false);
    expect(cal.calibrate(0.62)).toBe(0.62);
  });

  it("uses the measured rate once ready, pulled toward the score for thin bands", () => {
    const cal = buildCalibrator([...batch(0.45, 50, 20), ...batch(0.65, 50, 30)]);
    expect(cal.ready).toBe(true);
    // 40% measured at 0.45 with 50 setups: (20 + 10 * 0.45) / 60
    expect(cal.calibrate(0.45)).toBeCloseTo((20 + 4.5) / 60, 3);
    expect(cal.calibrate(0.65)).toBeCloseTo((30 + 6.5) / 60, 3);
    // Between the two band averages it runs in a straight line.
    const mid = cal.calibrate(0.55);
    expect(mid).toBeGreaterThan(cal.calibrate(0.45));
    expect(mid).toBeLessThan(cal.calibrate(0.65));
  });

  it("never lets a higher score mean a lower chance", () => {
    const cal = buildCalibrator([...batch(0.45, 60, 36), ...batch(0.65, 60, 18)]);
    expect(cal.calibrate(0.65)).toBeGreaterThanOrEqual(cal.calibrate(0.45));
  });

  it("calibrates each scorer separately and leaves swing setups out", () => {
    const tfjs = batch(0.6, 50, 50).map((s) => ({ ...s, scorer: "tfjs" as const }));
    const swing = batch(0.6, 50, 0).map((s) => ({ ...s, horizon: "swing" as const }));
    expect(buildCalibrator([...tfjs, ...swing], "heuristic").samples).toBe(0);
    expect(buildCalibrator([...tfjs, ...swing], "tfjs").samples).toBe(50);
  });
});

describe("the Learning card", () => {
  it("says how many setups are still needed", () => {
    const { container } = render(createElement(WinChanceCalibration, { shadows: [resolved(0.6, "target")] }));
    expect(container.textContent).toContain(`1 of ${MIN_CALIBRATION_SAMPLES} setups finished`);
  });

  it("shows what each score band won once ready", () => {
    const shadows = Array.from({ length: 50 }, (_, i) => resolved(0.62, i < 25 ? "target" : "stop"));
    const { container } = render(createElement(WinChanceCalibration, { shadows }));
    expect(container.textContent).toContain("Measured from 50 finished setups");
    expect(container.textContent).toContain("60–70%");
    expect(container.textContent).toContain("50%"); // worked out
  });
});

describe("scanner with a measured win chance", () => {
  beforeEach(() => _resetScannedCandles());

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
  const fixed = (p: number): Calibrator => ({ ready: true, samples: 120, bands: [], calibrate: () => p });

  it("uses the measured chance for the profit check and says so", async () => {
    const report = await scanAllMarkets({ ...options, calibrators: { heuristic: fixed(0.7) } });
    const p = report.newProposals[0];
    expect(p.metaScore.calibratedWinProbability).toBe(0.7);
    expect(p.metaScore.confidenceRationale).toMatch(/Measured win chance at this score: 70% \(from 120 tracked setups\)/);
    expect(report.shadows.find((s) => s.kind === "proposed")?.scorer).toBe("heuristic");
  });

  it("skips a setup whose measured chance leaves no edge", async () => {
    const report = await scanAllMarkets({ ...options, calibrators: { heuristic: fixed(0.2) } });
    expect(report.newProposals).toEqual([]);
    expect(report.outcomes[0]).toMatchObject({ proposed: false });
  });

  it("ignores a calibrator that isn't ready", async () => {
    const notReady: Calibrator = { ...fixed(0.2), ready: false };
    const report = await scanAllMarkets({ ...options, calibrators: { heuristic: notReady } });
    expect(report.outcomes).toEqual([{ symbol: "SOL/INR", proposed: true }]);
  });
});
