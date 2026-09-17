import {
  StrategySetup,
  MetaLabelScore,
  ExpectedValueAssessment,
  RiskCalculation,
  Position,
  FailureInjectionState,
} from "../types";

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
  fixedBrokerageFeeDollars: number; // ₹20 flat brokerage per order
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
  autopilotMaxApprovalsPerHour: 3,
  autopilotMinConsensus: 0.7,
  autopilotMinPersonaVotes: 3,
};

// 1. Calculate Expected Net Value after conservative costs (Section 7)
export function evaluateExpectedValue(
  setup: StrategySetup,
  metaScore: MetaLabelScore,
  spread: number,
  depthScore: number
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

  // Costs estimation:
  const estimatedSpreadCost = spread * units;
  const estimatedBrokerageFee = 40.0; // ₹40 Round trip brokerage
  const slippageRate = depthScore < 40 ? 0.0006 : 0.0002; // higher in thin liquidity
  const estimatedSlippageCost = setup.entryPrice * units * slippageRate;
  const estimatedLatencyTax = 5.0; // buffer for micro-delays

  const totalCost = Number(
    (estimatedSpreadCost +
      estimatedBrokerageFee +
      estimatedSlippageCost +
      estimatedLatencyTax).toFixed(2)
  );

  const rawGrossEdge = pWin * avgWinDollars - pLoss * avgLossDollars;
  const expectedNetValue = Number((rawGrossEdge - totalCost).toFixed(2));

  return {
    pWin,
    avgWinDollars: Number(avgWinDollars.toFixed(2)),
    pLoss: Number(pLoss.toFixed(2)),
    avgLossDollars: Number(avgLossDollars.toFixed(2)),
    estimatedSpreadCost: Number(estimatedSpreadCost.toFixed(2)),
    estimatedBrokerageFee,
    estimatedSlippageCost: Number(estimatedSlippageCost.toFixed(2)),
    estimatedLatencyTax,
    totalCost,
    expectedNetValue,
    isPositiveEdge: expectedNetValue > 0,
  };
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
  isDataStale: boolean
): RiskCalculation {
  const { equity, maxRiskFraction, hardDailyLossLimit, maxAllowedExposureFraction, maxSimultaneousPositions } = policy;

  let passed = true;
  let rejectionReason: string | undefined;

  // Check Global Kill Switch
  if (failureState.globalKillSwitchActive) {
    passed = false;
    rejectionReason = "REJECTED BY RISK: Global Kill Switch is ACTIVE. All trading halted.";
  }

  // Check Stale Data
  if (passed && (isDataStale || failureState.simulateStaleMarketData)) {
    passed = false;
    rejectionReason = "REJECTED BY RISK: Stale or inconsistent market data detected. Fail-closed enforced.";
  }

  // Check Hard Daily Loss Limit
  const simulatedDailyLoss = failureState.simulateDailyLossBreach ? hardDailyLossLimit + 150 : currentDailyLoss;
  if (passed && simulatedDailyLoss >= hardDailyLossLimit) {
    passed = false;
    rejectionReason = `REJECTED BY RISK: Hard daily loss limit breached (₹${simulatedDailyLoss.toFixed(2)} >= ₹${hardDailyLossLimit}). Stopped opening new positions.`;
  }

  // Check Maximum Simultaneous Positions
  if (passed && activePositions.length >= maxSimultaneousPositions) {
    passed = false;
    rejectionReason = `REJECTED BY RISK: Maximum simultaneous positions reached (${activePositions.length}/${maxSimultaneousPositions}).`;
  }

  // Check Liquidity / Order Book Filter (Section 7)
  const effectiveDepth = failureState.simulateOrderBookThinLiquidity ? 15 : orderBookDepthScore;
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
  const sameSymbolPositions = activePositions.filter((p) => p.symbol === setup.symbol);
  if (passed && sameSymbolPositions.length >= 1) {
    passed = false;
    rejectionReason = `REJECTED BY RISK: Existing active position already open on ${setup.symbol}.`;
  }

  // Current total exposure
  const currentExposure = activePositions.reduce((acc, p) => acc + p.quantity * p.currentPrice, 0);
  const currentExposureFraction = currentExposure / equity;
  if (passed && currentExposureFraction >= maxAllowedExposureFraction) {
    passed = false;
    rejectionReason = `REJECTED BY RISK: Portfolio exposure (${(currentExposureFraction * 100).toFixed(1)}%) exceeds limit (${(maxAllowedExposureFraction * 100).toFixed(1)}%).`;
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
  const recommendedUnits = Number(Math.min(rawUnits, maxUnitsByValue).toFixed(2));
  const recommendedDollarExposure = Number((recommendedUnits * setup.entryPrice).toFixed(2));

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
  const sorted = [...setups].sort((a, b) => b.metaScore.confidence - a.metaScore.confidence);
  return sorted[0];
}
