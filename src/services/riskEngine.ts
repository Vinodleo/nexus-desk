import {
  StrategySetup,
  MetaLabelScore,
  ExpectedValueAssessment,
  RiskCalculation,
  Position,
  FailureInjectionState,
} from "../types";
import { SUPPORTED_SYMBOLS, getSymbolConfig } from "./marketDataService";

export interface RiskPolicyConfig {
  equity: number;
  maxRiskFraction: number; // 0.01 (1.0% max risk ceiling per trade)
  hardDailyLossLimit: number; // ₹25,000 max daily loss
  maxAllowedExposureFraction: number; // 0.50 (50% max total margin exposure)
  maxSimultaneousPositions: number; // 3 positions
  maxCorrelatedPositionsPerGroup: number; // 2 in same group (e.g. INDIAN_EQUITIES, CRYPTO_MAJOR)
  turnoverCapHourly: number; // 4 trades per hour max
  minLiquidityScore: number; // 30 minimum order book depth
  maxSpreadTolerancePercent: number; // 0.08% max spread
  fixedBrokerageFeeDollars: number; // legacy equity-style flat fee — unused now, kept for backward compatibility
  // CoinDCX INR-Margin Futures Fee Structure:
  // 0.02% maker / 0.05% taker per side, applying to both opening and closing a position.
  takerFeeRatePerSide: number; // 0.0005 (0.05% per side taker fee)
  makerFeeRatePerSide: number; // 0.0002 (0.02% per side maker fee)
  takerFeeRateRoundTrip: number; // 0.0010 (0.10% round trip conservative assumption for taker open + taker close)
  autopilotMaxApprovalsPerHour: number; // hard cap on trades opened via Autonomous Self-Approval per rolling hour
  autopilotMinConsensus: number; // 0..1 — min weighted trader-panel agreement required for self-approval
  autopilotMinPersonaVotes: number; // min number of personas that must have voted for self-approval to fire
}

export const DEFAULT_RISK_POLICY: RiskPolicyConfig = {
  equity: 100000, // ₹1 Lakh paper capital
  maxRiskFraction: 0.003, // 0.3% = ₹300 max risk per trade
  hardDailyLossLimit: 2500, // ₹2,500 hard daily loss limit
  maxAllowedExposureFraction: 0.10, // 10% = ₹10,000 total trading limit / maximum exposure
  maxSimultaneousPositions: 3,
  maxCorrelatedPositionsPerGroup: 2,
  turnoverCapHourly: 4,
  minLiquidityScore: 35,
  maxSpreadTolerancePercent: 0.10,
  fixedBrokerageFeeDollars: 20.0,
  // CoinDCX INR-Margin Futures Fee:
  // 0.02% maker / 0.05% taker applied to both opening and closing.
  // Using 0.05% per side (0.10% round-trip) as the conservative baseline taker rate.
  takerFeeRatePerSide: 0.0005,
  makerFeeRatePerSide: 0.0002,
  takerFeeRateRoundTrip: 0.0010, // 0.05% open + 0.05% close = 0.10% round-trip
  autopilotMaxApprovalsPerHour: 3,
  autopilotMinConsensus: 0.7,
  autopilotMinPersonaVotes: 2,
};

// 1. Calculate Expected Net Value after conservative costs (Section 7)
export function evaluateExpectedValue(
  setup: StrategySetup,
  metaScore: MetaLabelScore,
  spread: number,
  depthScore: number,
  policy: RiskPolicyConfig = DEFAULT_RISK_POLICY
): ExpectedValueAssessment {
  const pWin = metaScore.calibratedWinProbability;
  const pLoss = 1 - pWin;
  const riskPerUnit = Math.abs(setup.entryPrice - setup.stopLoss);
  const rewardPerUnit = Math.abs(setup.takeProfit - setup.entryPrice);

  // Standardized INR size of 1 risk unit (₹300)
  const baseRiskDollars = 300;
  const units = riskPerUnit > 0 ? baseRiskDollars / riskPerUnit : 1;
  const avgWinDollars = rewardPerUnit * units;
  const avgLossDollars = riskPerUnit * units;

  // Costs estimation — genuinely different fee structures per asset class,
  // not a one-size-fits-all constant. Crypto exchanges (CoinDCX) charge a
  // percentage-of-trade-value taker fee; Zerodha (equities) charges a flat
  // fee per executed order regardless of trade size (₹20 or 0.03%,
  // whichever is lower, for intraday — flat ₹20 is the safe conservative
  // assumption at the trade sizes this app runs).
  const isEquity = !setup.symbol.includes("/");
  const estimatedSpreadCost = spread * units;
  const estimatedBrokerageFee = isEquity
    ? 40.0 // ~₹20/side, ₹40 round trip flat — Zerodha intraday equity brokerage
    : setup.entryPrice * units * policy.takerFeeRateRoundTrip;
  const slippageRate = depthScore < 40 ? 0.0006 : 0.0002; // higher in thin liquidity

  const estimatedSlippageCost = setup.entryPrice * units * slippageRate;
  const estimatedLatencyTax = 5.0; // buffer for micro-delays

  const totalCost = Number(
    (
      estimatedSpreadCost +
      estimatedBrokerageFee +
      estimatedSlippageCost +
      estimatedLatencyTax
    ).toFixed(2)
  );

  const rawGrossEdge = pWin * avgWinDollars - pLoss * avgLossDollars;
  const expectedNetValue = Number((rawGrossEdge - totalCost).toFixed(2));

  return {
    pWin,
    avgWinDollars: Number(avgWinDollars.toFixed(2)),
    pLoss: Number(pLoss.toFixed(2)),
    avgLossDollars: Number(avgLossDollars.toFixed(2)),
    estimatedSpreadCost: Number(estimatedSpreadCost.toFixed(2)),
    estimatedBrokerageFee: Number(estimatedBrokerageFee.toFixed(2)),
    estimatedSlippageCost: Number(estimatedSlippageCost.toFixed(2)),
    estimatedLatencyTax,
    totalCost,
    expectedNetValue,
    isPositiveEdge: expectedNetValue > 0,
  };
}

export interface RiskEngineEvaluationOptions {
  quarantinedUntilMs?: number;
  spread?: number;
}

// 2. Deterministic Risk Engine evaluation & Kelly sizing (Section 8)
export function evaluateRiskEngine(
  setup: StrategySetup,
  metaScore: MetaLabelScore,
  ev: ExpectedValueAssessment,
  activePositions: Position[],
  currentDailyLoss: number,
  orderBookDepthScore: number,
  recentHourlyTradeCount: number,
  policy: RiskPolicyConfig,
  failureState: FailureInjectionState,
  isDataStale: boolean,
  options?: RiskEngineEvaluationOptions
): RiskCalculation {
  const {
    equity,
    maxRiskFraction,
    hardDailyLossLimit,
    maxAllowedExposureFraction,
    maxSimultaneousPositions,
  } = policy;

  let passed = true;
  let rejectionReason: string | undefined;

  // Check Global Kill Switch
  if (failureState.globalKillSwitchActive) {
    passed = false;
    rejectionReason =
      "REJECTED BY RISK: Global Kill Switch is ACTIVE. All trading halted.";
  }

  // Check Symbol Quarantine (Embargo after consecutive losses)
  if (
    passed &&
    options?.quarantinedUntilMs &&
    options.quarantinedUntilMs > Date.now()
  ) {
    const remainingMins = Math.ceil(
      (options.quarantinedUntilMs - Date.now()) / 60000
    );
    passed = false;
    rejectionReason = `REJECTED BY RISK: ${setup.symbol} is under embargo (${remainingMins}m remaining) due to consecutive loss protection.`;
  }

  // Check Spread-to-Stop Ratio (Reject if spread is too wide compared to stop loss distance)
  const spreadStopDistance = Math.abs(setup.entryPrice - setup.stopLoss);
  if (passed && options?.spread !== undefined && spreadStopDistance > 0) {
    const spreadFractionOfStop = options.spread / spreadStopDistance;
    // If the spread eats more than 25% of the stop loss, the trade is practically unviable
    if (spreadFractionOfStop > 0.25) {
      passed = false;
      rejectionReason = `REJECTED BY RISK: Bid-ask spread (₹${options.spread.toFixed(
        2
      )}) is ${(spreadFractionOfStop * 100).toFixed(
        0
      )}% of stop distance (₹${spreadStopDistance.toFixed(
        2
      )}). Max allowed is 25%.`;
    }
  }

  // Check Stale Data
  if (passed && (isDataStale || failureState.simulateStaleMarketData)) {
    passed = false;
    rejectionReason =
      "REJECTED BY RISK: Stale or inconsistent market data detected. Fail-closed enforced.";
  }

  // Check Hard Daily Loss Limit
  const simulatedDailyLoss = failureState.simulateDailyLossBreach
    ? hardDailyLossLimit + 150
    : currentDailyLoss;
  if (passed && simulatedDailyLoss >= hardDailyLossLimit) {
    passed = false;
    rejectionReason = `REJECTED BY RISK: Hard daily loss limit breached (₹${simulatedDailyLoss.toFixed(
      2
    )} >= ₹${hardDailyLossLimit}). Stopped opening new positions.`;
  }

  // Check Maximum Simultaneous Positions
  if (passed && activePositions.length >= maxSimultaneousPositions) {
    passed = false;
    rejectionReason = `REJECTED BY RISK: Maximum simultaneous positions reached (${activePositions.length}/${maxSimultaneousPositions}).`;
  }

  // Check Liquidity / Order Book Filter (Section 7)
  const effectiveDepth = failureState.simulateOrderBookThinLiquidity
    ? 15
    : orderBookDepthScore;
  if (passed && effectiveDepth < policy.minLiquidityScore) {
    passed = false;
    rejectionReason = `REJECTED BY RISK: Liquidity filter failed. Order book depth score ${effectiveDepth} < minimum ${policy.minLiquidityScore}.`;
  }

  // Check Turnover Cap (Section 7)
  if (passed && recentHourlyTradeCount >= policy.turnoverCapHourly) {
    passed = false;
    rejectionReason = `REJECTED BY RISK: Turnover cap reached (${recentHourlyTradeCount}/${policy.turnoverCapHourly} trades/hour). Skipping marginal candidate.`;
  }

  // Check Expected Net Edge (Section 7)
  if (passed && !ev.isPositiveEdge) {
    passed = false;
    rejectionReason = `REJECTED BY RISK: Negative expectancy after fees and slippage (Net EV: ₹${ev.expectedNetValue}).`;
  }

  // Check Correlation Exposure (Section 8)
  const sameSymbolPositions = activePositions.filter(
    (p) => p.symbol === setup.symbol
  );
  if (passed && sameSymbolPositions.length >= 1) {
    passed = false;
    rejectionReason = `REJECTED BY RISK: Existing active position already open on ${setup.symbol}.`;
  }

  // Current total exposure
  const currentExposure = activePositions.reduce(
    (acc, p) => acc + p.quantity * p.currentPrice,
    0
  );
  const currentExposureFraction = currentExposure / equity;
  if (passed && currentExposureFraction >= maxAllowedExposureFraction) {
    passed = false;
    rejectionReason = `REJECTED BY RISK: Portfolio exposure (${(
      currentExposureFraction * 100
    ).toFixed(1)}%) exceeds limit (${(
      maxAllowedExposureFraction * 100
    ).toFixed(1)}%).`;
  }

  // Fractional Kelly sizing calculation (Quarter-Kelly bounded strictly by fixed fraction ceiling)
  // f* = (p * b - q) / b
  const b = setup.riskRewardRatio;
  const p = metaScore.calibratedWinProbability;
  const q = 1 - p;
  const fullKelly = b > 0 ? Math.max(0, (p * b - q) / b) : 0;
  const quarterKelly = 0.25 * fullKelly;

  // Bounded above by fixed per-trade risk fraction:
  // "confidence-scaled sizing should only reduce risk relative to that ceiling, never increase it"
  const effectiveRiskFraction = Math.min(maxRiskFraction, quarterKelly);
  const riskDollars = Number((equity * effectiveRiskFraction).toFixed(2));
  const stopDistance = Math.abs(setup.entryPrice - setup.stopLoss);
  const rawUnits = stopDistance > 0 ? riskDollars / stopDistance : 0;

  // Max order value cap (10k INR)
  const maxOrderValue = 10000;
  const maxUnitsByValue = maxOrderValue / setup.entryPrice;
  let recommendedUnits = Math.min(rawUnits, maxUnitsByValue);

  // Snap to exchange lot size
  const symConfig = getSymbolConfig(setup.symbol);
  const lotSize = symConfig?.lotSize || 1;
  const lots = Math.floor(recommendedUnits / lotSize);
  recommendedUnits = Number((lots * lotSize).toFixed(6));

  if (recommendedUnits === 0 && passed) {
    passed = false;
    rejectionReason = `Calculated risk position size is smaller than the exchange minimum lot size (${lotSize}) for ${setup.symbol}.`;
  }

  const recommendedDollarExposure = Number(
    (recommendedUnits * setup.entryPrice).toFixed(2)
  );

  return {
    equity,
    maxRiskPerTradeFraction: maxRiskFraction,
    hardDailyLossLimit,
    currentDailyLoss: simulatedDailyLoss,
    portfolioExposureFraction: Number(currentExposureFraction.toFixed(3)),
    maxAllowedExposureFraction,
    openPositionCount: activePositions.length,
    maxSimultaneousPositions,
    fractionalKellyFraction: Number(quarterKelly.toFixed(4)),
    recommendedPositionSizeUnits: recommendedUnits,
    recommendedDollarExposure,
    riskDollars,
    passedAllChecks: passed,
    rejectionReason,
  };
}

// Arbitrate conflicting setups (Section 8: "resolve by confidence-ranked arbitration")
export function arbitrateConflictingSetups(
  setups: { setup: StrategySetup; metaScore: MetaLabelScore }[]
): { setup: StrategySetup; metaScore: MetaLabelScore } | null {
  if (!setups.length) return null;
  // Sort descending by meta-model confidence
  const sorted = [...setups].sort(
    (a, b) => b.metaScore.confidence - a.metaScore.confidence
  );
  return sorted[0];
}
