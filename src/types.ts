export type RegimeType =
  | "trending_bullish"
  | "trending_bearish"
  | "ranging_tight"
  | "ranging_wide"
  | "high_volatility_choppy";

export type StrategyFamily =
  | "trend_following"
  | "breakout_confirmation"
  | "mean_reversion"
  | "volatility_filter"
  | "event_news_filter";

export type TradeDirection = "LONG" | "SHORT";

export type DecisionMode = "MANUAL" | "SEMI_AUTO" | "AUTO_WITHIN_LIMITS";

export interface MarketBar {
  time: string;
  timestampMs?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  ema9?: number;
  ema21?: number;
  ema50?: number;
  ema200?: number;
  adx?: number;
  rsi?: number;
  atr?: number;
  bbUpper?: number;
  bbLower?: number;
}

export interface OrderBookLevel {
  price: number;
  size: number;
  total: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: number;
  midPrice: number;
  depthScore: number; // 0..100 liquidity metric
}

export interface StrategySetup {
  id: string;
  name: string;
  family: StrategyFamily;
  direction: TradeDirection;
  symbol: string;
  timeframe: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  baseProbability: number;
  qualifies: boolean;
  disqualificationReason?: string;
  /** Intraday (minutes-to-hours) vs swing (days-to-weeks) — defaults to intraday when omitted. Drives holding-time estimates, consensus pooling, and autopilot eligibility. */
  horizon?: "intraday" | "swing";
  features: {
    emaAlignment: boolean;
    volumeSurgeRatio: number;
    vwapDistancePercent: number;
    adx: number;
    rsi: number;
    atr: number;
  };
}

export interface ExperienceVector {
  id: string;
  timestamp: string;
  symbol: string;
  setupName: string;
  family: StrategyFamily;
  regime: RegimeType;
  features: {
    adx: number;
    rsi: number;
    volatilityRatio: number;
    volumeSurgeRatio: number;
    vwapDist: number;
  };
  metaConfidence: number;
  decision: "TRADE" | "NO_TRADE" | "REJECTED_BY_RISK";
  outcome?: "WIN" | "LOSS" | "BREAKEVEN";
  pnl?: number;
  pnlPercent?: number;
  postClassification?:
    | "good_decision_good_outcome"
    | "good_decision_bad_outcome"
    | "bad_decision_good_outcome"
    | "bad_decision_bad_outcome";
  tags: string[];
}

export interface MetaLabelScore {
  setupId: string;
  confidence: number; // 0..1
  calibratedWinProbability: number;
  historicalSampleCount: number;
  historicalWinRate: number;
  confidenceRationale: string;
  regimeFit: "optimal" | "acceptable" | "poor";
}

export interface ExpectedValueAssessment {
  pWin: number;
  avgWinDollars: number;
  pLoss: number;
  avgLossDollars: number;
  estimatedSpreadCost: number;
  estimatedBrokerageFee: number;
  estimatedSlippageCost: number;
  estimatedLatencyTax: number;
  totalCost: number;
  expectedNetValue: number; // EV = P(win)*avgWin - P(loss)*avgLoss - totalCost
  isPositiveEdge: boolean;
}

export interface RiskCalculation {
  equity: number;
  maxRiskPerTradeFraction: number; // e.g. 0.01 (1%)
  hardDailyLossLimit: number; // e.g. $1000
  currentDailyLoss: number;
  portfolioExposureFraction: number;
  maxAllowedExposureFraction: number;
  openPositionCount: number;
  maxSimultaneousPositions: number;
  fractionalKellyFraction: number; // e.g. 0.25 (Quarter-Kelly)
  recommendedPositionSizeUnits: number;
  recommendedDollarExposure: number;
  riskDollars: number;
  passedAllChecks: boolean;
  rejectionReason?: string;
}

export interface TradeProposal {
  id: string;
  timestamp: string;
  symbol: string;
  setup: StrategySetup;
  regime: RegimeType;
  metaScore: MetaLabelScore;
  evAssessment: ExpectedValueAssessment;
  riskCalc: RiskCalculation;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "EXPIRED" | "AUTO_EXECUTED" | "REJECTED_BY_RISK" | "DEFERRED";
  approvalExpiryMs: number;
  approvalToken?: string;
  supervisorNotes: string;
  failClosedReason?: string;
  expiresAt?: number;
  marketAnalysisSummary?: string;
  aiRecommendation?: "TRADE_FAVORED" | "CAUTION" | "AVOID";
  modelUsed?: string;
  failureConditionRisk?: string;
  /** Trader-panel fields — weighted share of personas backing this direction, and who was on each side. */
  ensembleAgreement?: number;
  supportingPersonas?: string[];
  dissentingPersonas?: string[];
  personaVotesCast?: number;
  /** Why autopilot passed this one to manual review instead of self-approving it. Unset means it hasn't been evaluated by autopilot yet, or it was approved. */
  deferralReason?: string;
}

export interface Order {
  id: string;
  proposalId: string;
  symbol: string;
  type: "LIMIT";
  direction: TradeDirection;
  limitPrice: number;
  quantity: number;
  status: "PLACED" | "FILLED" | "CANCELLED" | "REJECTED";
  placedAt: string;
  filledAt?: string;
  fillPrice?: number;
  realizedSlippage: number;
  feePaid: number;
}

export type TradingExecutionMode = "PAPER" | "LIVE_COINDCX";

export interface CoinDcxAccountBalance {
  totalInr: number;
  availableInr: number;
  lockedInr: number;
  totalUsdt: number;
  availableUsdt: number;
  lockedUsdt: number;
  loading: boolean;
  error?: string;
  lastUpdated?: string;
  keyMasked?: string;
}

// Server-reported CoinDCX credential and live-risk status. Keys themselves
// never leave the server.
export interface CoinDcxServerStatus {
  configured: boolean;
  keyMasked: string | null;
  liveRisk: {
    enabled: boolean;
    allowedMarkets: string[];
    maxOrderNotionalInr: number;
    maxDailyNotionalInr: number;
    maxDailyOrders: number;
    maxPriceDeviationPct: number;
    day: string;
    openedNotionalInrToday: number;
    openedOrdersToday: number;
    trackedNetQty: Record<string, number>;
  };
}

export interface Position {
  id: string;
  symbol: string;
  direction: TradeDirection;
  setupName: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  initialTakeProfit?: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  openTime: string;
  expectedHoldingTimeMinutes: number;
  metaConfidence: number;
  isSelfApproved?: boolean;
  highestPrice?: number;
  lowestPrice?: number;
  trailActive?: boolean;
  atrAtEntry?: number;
  family?: StrategyFamily;
  horizon?: "intraday" | "swing";
  trailMode?: "SCALP_TIGHT" | "TREND_RUNNER";
  isLiveOrder?: boolean;
  exchangeOrderId?: string;
}

export interface HistoricalTrade {
  id: string;
  positionId?: string;
  symbol: string;
  direction: TradeDirection;
  setupName: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  moneyPlaced: number; // Amount of money placed/allocated in the trade (₹)
  grossPnl?: number; // Gross P&L before exchange fees
  feesPaid?: number; // CoinDCX Futures fees (0.02% maker / 0.05% taker both open and close)
  realizedPnl: number; // Net profit earned (positive) or money lost (negative) after fees
  realizedPnlPercent: number;
  isWin: boolean;
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "MANUAL" | "EXPIRY_TIME";
  openedAt: string;
  closedAt: string;
  openedAtMs?: number;
  closedAtMs?: number;
  holdingDurationMinutes?: number;
  isSelfApproved?: boolean;
  highestPrice?: number;
  lowestPrice?: number;
  trailActive?: boolean;
  atrAtEntry?: number;
  autopsy?: TradeAutopsy;
}

export interface TradeAutopsy {
  id: string;
  positionId: string;
  symbol: string;
  setupName: string;
  direction: TradeDirection;
  entryPrice: number;
  exitPrice: number;
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "MANUAL_CLOSE" | "EXPIRY_TIME";
  realizedPnl: number;
  realizedPnlPercent: number;
  holdingDurationMinutes: number;
  classification:
    | "good_decision_good_outcome"
    | "good_decision_bad_outcome"
    | "bad_decision_good_outcome"
    | "bad_decision_bad_outcome";
  rootCause: string;
  recurringConditions: string[];
  learningTags: string[];
  metaModelCalibrationDelta: number;
  autopsySummary: string;
  timestamp: string;
}

export interface ModelVersion {
  id: string;
  name: string;
  type: "CHAMPION" | "CHALLENGER";
  version: string;
  trainedDate: string;
  sampleSizeTrades: number;
  netExpectancy: number;
  sharpeRatio: number;
  deflatedSharpeRatio: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  winRate: number;
  turnoverRatio: number;
  status: "ACTIVE" | "EVALUATING" | "REJECTED";
  regimePerformance: Record<RegimeType, { winRate: number; trades: number; expectancy: number }>;
}

export interface OptimizedParameters {
  slMultiplier: number;
  tpMultiplier: number;
  rsiThreshold: number;
  volSurgeThreshold: number;
  minConfidence: number;
}

export interface PromotedLabModel {
  promotedAt: string;
  datasetName: string;
  accuracyPct: number;
  winRatePct: number;
  sharpeRatio: number;
  totalCandlesEvaluated: number;
  distilledRulesCount: number;
  distilledLessons: { id: string; rule: string; regime: string; action: string }[];
  optimizedParameters?: OptimizedParameters;
  sourceExchange?: string;
  isSynthetic?: boolean;
  hasTrainedModel?: boolean;
}

export interface WalkForwardFold {
  foldIndex: number;
  trainRange: string;
  testRange: string;
  purgedTradesCount: number;
  embargoDays: number;
  inSampleSharpe: number;
  outOfSampleSharpe: number;
  deflatedSharpe: number;
  outOfSampleTradesCount: number;
  passed: boolean;
}

export interface BacktestSummary {
  strategyName: string;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  netPnl: number;
  maxDrawdown: number;
  sharpeRatio: number;
  deflatedSharpeRatio: number;
  minimumSampleSizePassed: boolean; // ≥30 per regime bucket, ≥100 total
  holdsOutPerformancePositive: boolean;
  folds: WalkForwardFold[];
  equityCurve: { time: string; timestampMs?: number; equity: number }[];
  candidateMeetsPromotionCriteria: boolean;
  promotionChecklist: {
    minimumSampleSizes: boolean;
    purgedWalkForwardStable: boolean;
    regimeIndependence: boolean;
    multipleTestingCorrectionPassed: boolean;
    holdoutPerformancePositive: boolean;
    costSlippageAccounted: boolean;
  };
}

export interface FailureInjectionState {
  simulateAgentTimeout: boolean;
  simulateStaleMarketData: boolean;
  simulateDailyLossBreach: boolean;
  simulateOrderBookThinLiquidity: boolean;
  simulateConflictingSignals: boolean;
  globalKillSwitchActive: boolean;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  component:
    | "MARKET_DATA"
    | "MARKET_ANALYSIS_AGENT"
    | "STRATEGY_AGENT"
    | "EXPERIENCE_RETRIEVAL"
    | "META_LABELING"
    | "RISK_ENGINE"
    | "SUPERVISOR_AGENT"
    | "APPROVAL_SERVICE"
    | "EXECUTION_SERVICE"
    | "TRADE_AUTOPSY"
    | "CHALLENGER_PIPELINE"
    | "KILL_SWITCH";
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  message: string;
  details?: any;
}
