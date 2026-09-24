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
  /** Generated, not observed. Set on backfilled or simulated bars. */
  isSynthetic?: boolean;
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
  /** "coindcx" or "angelone" (NSE depth) when read from the market; otherwise it was simulated. */
  source?: "coindcx" | "angelone" | "simulated";
  /** Spread as a share of the mid price. */
  spreadPct?: number;
  /** Price moved past the best level to buy and then sell the trade size, as a share of price. */
  roundTripSlippage?: number;
  /** Rupees on offer near the price, on the thinner side. */
  depthInr?: number;
  fetchedAt?: number;
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
  /** Part of the generated starter memory bank, not a real trade. */
  isSeeded?: boolean;
  timestamp: string;
  symbol: string;
  setupName: string;
  family: StrategyFamily;
  /** Long or short; absent on older records. The memory only matches the same direction. */
  direction?: TradeDirection;
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
  /** Machine-readable reason, for counting why setups were skipped. */
  rejectionCode?: import("./services/scanOutcome").RiskRejectionCode;
}

export interface ProposalDataQuality {
  /** Share (0-1) of the price bars behind the signal that were generated. */
  syntheticBarShare: number;
  /** Share (0-1) of the similar past trades behind the win rate that are seeded examples. */
  seededExperienceShare: number;
  /** Order-book spread/depth used for costs and the liquidity check is simulated, not CoinDCX's. */
  simulatedOrderBook: boolean;
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
  /** How much of this proposal rests on generated rather than observed data. */
  dataQuality?: ProposalDataQuality;
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

export interface ExecutionToast {
  id: string;
  title: string;
  message: string;
  type: "SUCCESS" | "WARNING" | "INFO";
  timestamp: string;
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
  /** The stop at open; +1R is measured from it. */
  initialStopLoss?: number;
  /** How much to bank at +1R (paper positions), fitted to CoinDCX's quantity step. */
  partialQuantity?: number;
  /** How much was banked early and at what price; `quantity` stays the full size. */
  bankedQuantity?: number;
  bankedPrice?: number;
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
  /** Trailing-stop profile (shared/trailingStop TRAIL_PROFILES) chosen when it opened. */
  trailProfile?: string;
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
  /** Where the stop was when the trade closed, and the price the (rest of the) position actually sold at: a fast move can go past the stop between price checks. */
  stopAtExit?: number;
  fillAtExit?: number;
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
  /** Version of the model's inputs (metaFeatures); a model on another version isn't used live. */
  featureVersion?: number;
}

export interface FailureInjectionState {
  simulateAgentTimeout: boolean;
  simulateStaleMarketData: boolean;
  simulateDailyLossBreach: boolean;
  simulateOrderBookThinLiquidity: boolean;
  simulateConflictingSignals: boolean;
  globalKillSwitchActive: boolean;
}

