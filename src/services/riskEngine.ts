import { MARKET_LABEL, marketOf, openInMarket, type MarketLimits } from "../shared/marketLimits";
import {
  StrategySetup,
  MetaLabelScore,
  ExpectedValueAssessment,
  RiskCalculation,
  Position,
  FailureInjectionState,
} from "../types";
import { fitQuantity } from "../shared/marketRules";
import { openQuantity } from "../shared/exitRules";
import { nseRoundTripRate } from "../shared/nse";
import { ruleFor } from "./marketRulesStore";
import type { RiskRejectionCode } from "./scanOutcome";

export interface RiskPolicyConfig {
  equity: number;
  maxRiskFraction: number; // 0.01 (1.0% max risk ceiling per trade)
  hardDailyLossLimit: number; // ₹25,000 max daily loss
  maxAllowedExposureFraction: number; // 0.50 (50% max total margin exposure)
  maxOrderValueInr: number; // largest single position, in rupees
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
  /**
   * Amount per trade and trades open at once, per market (coins, stocks).
   * When set, they replace maxOrderValueInr, maxSimultaneousPositions and
   * the exposure fraction for sizing and the position count.
   */
  marketLimits?: MarketLimits;
}

export const DEFAULT_RISK_POLICY: RiskPolicyConfig = {
  equity: 100000, // ₹1 Lakh paper capital
  maxRiskFraction: 0.003, // 0.3% = ₹300 max risk per trade
  hardDailyLossLimit: 2500, // ₹2,500 hard daily loss limit
  maxAllowedExposureFraction: 0.10, // 10% = ₹10,000 total trading limit / maximum exposure
  maxOrderValueInr: 10000,
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
  policy: RiskPolicyConfig = DEFAULT_RISK_POLICY,
  /**
   * Round-trip slippage (share of price) measured on CoinDCX's order book.
   * Without it, slippage is estimated from the depth score.
   */
  measuredSlippage?: number
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

  // Costs estimation — different fee structures per asset class. Crypto
  // (CoinDCX) charges a percentage-of-trade-value taker fee; stocks (Angel
  // One intraday) a per-order brokerage plus STT, stamp duty and GST.
  const isEquity = !setup.symbol.includes("/");
  const estimatedSpreadCost = spread * units;
  const estimatedBrokerageFee = isEquity
    ? setup.entryPrice * units * nseRoundTripRate(setup.entryPrice * units) // Angel One intraday costs (shared/nse)
    : setup.entryPrice * units * policy.takerFeeRateRoundTrip;
  const estimatedRate = depthScore < 40 ? 0.0006 : 0.0002; // higher in thin liquidity
  // A book too thin to fill the trade gets a punitive 1%; the liquidity check rejects it anyway.
  const slippageRate =
    measuredSlippage === undefined ? estimatedRate : Number.isFinite(measuredSlippage) ? measuredSlippage : 0.01;

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
  let rejectionCode: RiskRejectionCode | undefined;

  // Check Global Kill Switch
  if (failureState.globalKillSwitchActive) {
    passed = false;
    rejectionCode = "kill_switch";
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
    rejectionCode = "quarantine";
    rejectionReason = `REJECTED BY RISK: ${setup.symbol} is under embargo (${remainingMins}m remaining) due to consecutive loss protection.`;
  }

  // Check Spread-to-Stop Ratio (Reject if spread is too wide compared to stop loss distance)
  const spreadStopDistance = Math.abs(setup.entryPrice - setup.stopLoss);
  if (passed && options?.spread !== undefined && spreadStopDistance > 0) {
    const spreadFractionOfStop = options.spread / spreadStopDistance;
    // If the spread eats more than 25% of the stop loss, the trade is practically unviable
    if (spreadFractionOfStop > 0.25) {
      passed = false;
      rejectionCode = "spread";
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
    rejectionCode = "stale_data";
    rejectionReason =
      "REJECTED BY RISK: Stale or inconsistent market data detected. Fail-closed enforced.";
  }

  // Check Hard Daily Loss Limit
  const simulatedDailyLoss = failureState.simulateDailyLossBreach
    ? hardDailyLossLimit + 150
    : currentDailyLoss;
  if (passed && simulatedDailyLoss >= hardDailyLossLimit) {
    passed = false;
    rejectionCode = "daily_loss";
    rejectionReason = `REJECTED BY RISK: Hard daily loss limit breached (₹${simulatedDailyLoss.toFixed(
      2
    )} >= ₹${hardDailyLossLimit}). Stopped opening new positions.`;
  }

  // Check Maximum Simultaneous Positions: per market when set in Settings.
  const marketLimit = policy.marketLimits?.[marketOf(setup.symbol)];
  if (marketLimit) {
    const inMarket = openInMarket(activePositions, setup.symbol).length;
    if (passed && inMarket >= marketLimit.maxOpenTrades) {
      passed = false;
      rejectionCode = "max_positions";
      rejectionReason = `REJECTED BY RISK: Maximum open ${MARKET_LABEL[marketOf(setup.symbol)]} trades reached (${inMarket}/${marketLimit.maxOpenTrades}).`;
    }
  } else if (passed && activePositions.length >= maxSimultaneousPositions) {
    passed = false;
    rejectionCode = "max_positions";
    rejectionReason = `REJECTED BY RISK: Maximum simultaneous positions reached (${activePositions.length}/${maxSimultaneousPositions}).`;
  }

  // Check Liquidity / Order Book Filter (Section 7)
  const effectiveDepth = failureState.simulateOrderBookThinLiquidity
    ? 15
    : orderBookDepthScore;
  if (passed && effectiveDepth < policy.minLiquidityScore) {
    passed = false;
    rejectionCode = "liquidity";
    rejectionReason = `REJECTED BY RISK: Liquidity filter failed. Order book depth score ${effectiveDepth} < minimum ${policy.minLiquidityScore}.`;
  }

  // Check Turnover Cap (Section 7)
  if (passed && recentHourlyTradeCount >= policy.turnoverCapHourly) {
    passed = false;
    rejectionCode = "turnover";
    rejectionReason = `REJECTED BY RISK: Turnover cap reached (${recentHourlyTradeCount}/${policy.turnoverCapHourly} trades/hour). Skipping marginal candidate.`;
  }

  // Check Expected Net Edge (Section 7)
  if (passed && !ev.isPositiveEdge) {
    passed = false;
    rejectionCode = "negative_ev";
    rejectionReason = `REJECTED BY RISK: Negative expectancy after fees and slippage (Net EV: ₹${ev.expectedNetValue}).`;
  }

  // Check Correlation Exposure (Section 8)
  const sameSymbolPositions = activePositions.filter(
    (p) => p.symbol === setup.symbol
  );
  if (passed && sameSymbolPositions.length >= 1) {
    passed = false;
    rejectionCode = "existing_position";
    rejectionReason = `REJECTED BY RISK: Existing active position already open on ${setup.symbol}.`;
  }

  // Current total exposure
  const currentExposure = activePositions.reduce(
    (acc, p) => acc + openQuantity(p) * p.currentPrice,
    0
  );
  const currentExposureFraction = currentExposure / equity;
  // With per-market limits, amount per trade × trades at once bounds exposure instead.
  if (passed && !marketLimit && currentExposureFraction >= maxAllowedExposureFraction) {
    passed = false;
    rejectionCode = "exposure";
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

  // Cap the position's value, and don't let it push total exposure past
  // the limit, then fit it to CoinDCX's quantity step and minimums.
  const exposureRoom = Math.max(0, maxAllowedExposureFraction * equity - currentExposure);
  const maxValue = marketLimit ? marketLimit.amountPerTradeInr : Math.min(policy.maxOrderValueInr, exposureRoom);
  const maxUnitsByValue = setup.entryPrice > 0 ? maxValue / setup.entryPrice : 0;
  const fit = fitQuantity(Math.min(rawUnits, maxUnitsByValue), setup.entryPrice, ruleFor(setup.symbol, setup.entryPrice));
  const recommendedUnits = fit.quantity;

  if (!fit.ok && passed) {
    passed = false;
    rejectionCode = "size";
    rejectionReason = `REJECTED BY RISK: ${fit.reason}`;
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
    rejectionCode,
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
