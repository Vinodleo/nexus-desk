import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_POLICY, evaluateExpectedValue, evaluateRiskEngine } from "../../src/services/riskEngine";
import type { ExpectedValueAssessment, FailureInjectionState, MetaLabelScore, Position, StrategySetup } from "../../src/types";

const setup = (over: Partial<StrategySetup> = {}): StrategySetup => ({
  id: "s1",
  name: "Test Setup",
  family: "trend_following" as StrategySetup["family"],
  direction: "LONG",
  symbol: "BTC/INR",
  timeframe: "5m",
  entryPrice: 1000,
  stopLoss: 990,
  takeProfit: 1030,
  riskRewardRatio: 3,
  baseProbability: 0.55,
  qualifies: true,
  features: { emaAlignment: true, volumeSurgeRatio: 1.5, vwapDistancePercent: 0.1, adx: 30, rsi: 55, atr: 10 },
  ...over,
});

const meta = (p = 0.6): MetaLabelScore => ({
  setupId: "s1",
  confidence: p,
  calibratedWinProbability: p,
  historicalSampleCount: 50,
  historicalWinRate: p,
  confidenceRationale: "",
  regimeFit: "optimal",
});

const noFailures: FailureInjectionState = {
  simulateAgentTimeout: false,
  simulateStaleMarketData: false,
  simulateDailyLossBreach: false,
  simulateOrderBookThinLiquidity: false,
  simulateConflictingSignals: false,
  globalKillSwitchActive: false,
};

const positiveEv = { isPositiveEdge: true, expectedNetValue: 100 } as ExpectedValueAssessment;

const pos = (symbol: string, quantity = 1, currentPrice = 1000) =>
  ({ id: symbol, symbol, quantity, currentPrice } as Position);

function run(over: {
  setup?: StrategySetup;
  meta?: MetaLabelScore;
  ev?: ExpectedValueAssessment;
  positions?: Position[];
  dailyLoss?: number;
  depth?: number;
  hourly?: number;
  failures?: Partial<FailureInjectionState>;
  stale?: boolean;
  options?: Parameters<typeof evaluateRiskEngine>[10];
} = {}) {
  return evaluateRiskEngine(
    over.setup ?? setup(),
    over.meta ?? meta(),
    over.ev ?? positiveEv,
    over.positions ?? [],
    over.dailyLoss ?? 0,
    over.depth ?? 80,
    over.hourly ?? 0,
    DEFAULT_RISK_POLICY,
    { ...noFailures, ...over.failures },
    over.stale ?? false,
    over.options
  );
}

describe("evaluateRiskEngine", () => {
  it("passes a clean setup", () => {
    const r = run();
    expect(r.passedAllChecks).toBe(true);
    expect(r.rejectionReason).toBeUndefined();
  });

  it.each([
    ["kill switch", { failures: { globalKillSwitchActive: true } }, /Kill Switch/],
    ["quarantine", { options: { quarantinedUntilMs: Date.now() + 10 * 60000 } }, /embargo/],
    ["spread > 25% of stop", { options: { spread: 3 } }, /spread/i],
    ["stale data", { stale: true }, /Stale/],
    ["daily loss limit", { dailyLoss: DEFAULT_RISK_POLICY.hardDailyLossLimit }, /daily loss limit/],
    ["max positions", { positions: [pos("ETH/INR", 0.001), pos("SOL/INR", 0.001), pos("XRP/INR", 0.001)] }, /Maximum simultaneous/],
    ["thin liquidity", { depth: 10 }, /Liquidity/],
    ["turnover cap", { hourly: DEFAULT_RISK_POLICY.turnoverCapHourly }, /Turnover/],
    ["negative EV", { ev: { isPositiveEdge: false, expectedNetValue: -5 } as ExpectedValueAssessment }, /Negative expectancy/],
    ["same symbol already open", { positions: [pos("BTC/INR", 0.001)] }, /already open/],
    ["exposure limit", { positions: [pos("ETH/INR", 10, 1000)] }, /exposure/],
  ])("rejects on %s", (_name, over, reason) => {
    const r = run(over as Parameters<typeof run>[0]);
    expect(r.passedAllChecks).toBe(false);
    expect(r.rejectionReason).toMatch(reason);
  });

  it("caps quarter-Kelly at the fixed per-trade risk fraction", () => {
    // p=0.9, b=3: full Kelly = (2.7 - 0.1)/3 = 0.8667, quarter = 0.2167 >> 0.3%
    const r = run({ meta: meta(0.9) });
    expect(r.fractionalKellyFraction).toBeCloseTo(0.2167, 4);
    expect(r.riskDollars).toBe(DEFAULT_RISK_POLICY.equity * DEFAULT_RISK_POLICY.maxRiskFraction); // ₹300
  });

  it("sizes down when quarter-Kelly is below the ceiling", () => {
    // p=0.26, b=3: full Kelly = (0.78 - 0.74)/3 = 0.01333, quarter = 0.00333... still > 0.003 cap
    // p=0.255: full = (0.765-0.745)/3 = 0.00667, quarter = 0.001667 -> ₹166.67
    const r = run({ meta: meta(0.255) });
    expect(r.riskDollars).toBeCloseTo(166.67, 2);
  });

  it("gives zero size for a negative-Kelly edge", () => {
    const r = run({ meta: meta(0.2) });
    expect(r.fractionalKellyFraction).toBe(0);
    expect(r.recommendedPositionSizeUnits).toBe(0);
    expect(r.passedAllChecks).toBe(false);
  });

  it("caps order value at ₹10,000 and snaps to the lot size", () => {
    // ₹300 risk / ₹10 stop = 30 units = ₹30,000 -> capped to 10 units
    const r = run({ meta: meta(0.9) });
    expect(r.recommendedDollarExposure).toBeLessThanOrEqual(10000);
    expect(r.recommendedPositionSizeUnits).toBeGreaterThan(0);
  });
});

describe("evaluateExpectedValue", () => {
  it("subtracts all costs from the gross edge", () => {
    const ev = evaluateExpectedValue(setup(), meta(0.6), 0.5, 80);
    expect(ev.totalCost).toBeCloseTo(
      ev.estimatedSpreadCost + ev.estimatedBrokerageFee + ev.estimatedSlippageCost + ev.estimatedLatencyTax,
      1
    );
    expect(ev.expectedNetValue).toBeCloseTo(0.6 * ev.avgWinDollars - 0.4 * ev.avgLossDollars - ev.totalCost, 1);
    expect(ev.isPositiveEdge).toBe(ev.expectedNetValue > 0);
  });

  it("charges more slippage in thin books", () => {
    const deep = evaluateExpectedValue(setup(), meta(0.6), 0.5, 80);
    const thin = evaluateExpectedValue(setup(), meta(0.6), 0.5, 20);
    expect(thin.estimatedSlippageCost).toBeGreaterThan(deep.estimatedSlippageCost);
  });

  it("charges stocks Angel One's intraday costs, not the crypto fee", () => {
    const ev = evaluateExpectedValue(setup({ symbol: "RELIANCE" }), meta(0.6), 0.5, 80);
    const crypto = evaluateExpectedValue(setup({ symbol: "BTC/INR" }), meta(0.6), 0.5, 80);
    // Per-order brokerage plus STT, stamp duty and GST: more than CoinDCX's 0.1% round trip.
    expect(ev.estimatedBrokerageFee).toBeGreaterThan(crypto.estimatedBrokerageFee);
  });
});
