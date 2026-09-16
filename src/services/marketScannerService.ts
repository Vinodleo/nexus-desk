import {
  ExpectedValueAssessment,
  FailureInjectionState,
  MarketBar,
  MetaLabelScore,
  OrderBook,
  Position,
  RegimeType,
  RiskCalculation,
  StrategySetup,
  TradeProposal,
} from "../types";
import {
  SUPPORTED_SYMBOLS,
  SymbolConfig,
  classifyRegime,
  generateInitialBars,
  generateOrderBook,
} from "./marketDataService";
import { evaluatePredefinedSetups } from "./strategyEngine";
import { liveMarketStream } from "./liveMarketStreamService";
import {
  generateInitialExperienceDatabase,
  retrieveSimilarExperiences,
} from "./experienceMemory";
import { computeMetaLabelScore } from "./metaLabeling";
import {
  DEFAULT_RISK_POLICY,
  RiskPolicyConfig,
  evaluateExpectedValue,
  evaluateRiskEngine,
} from "./riskEngine";
import { loadStoredPromotedLabModel } from "./storagePersistenceService";

export interface ScanMarketOptions {
  symbols?: string[];
  barsMap?: Record<string, MarketBar[]>;
  activePositions: Position[];
  dailyRealizedPnl: number;
  failureState: FailureInjectionState;
  riskPolicy?: RiskPolicyConfig;
  experiences?: any[];
}

export interface MarketScanResult {
  symbol: string;
  symbolName: string;
  price: number;
  regime: RegimeType;
  evaluatedSetupsCount: number;
  qualifiedSetupsCount: number;
  orderBook: OrderBook;
  proposals: TradeProposal[];
  summaryNote: string;
}

export interface FullScanReport {
  timestamp: string;
  totalMarketsScanned: number;
  totalSetupsEvaluated: number;
  totalProposalsPlacedInQueue: number;
  resultsBySymbol: MarketScanResult[];
  newProposals: TradeProposal[];
}

/**
 * Scans a single market symbol, calculates indicators and regimes,
 * checks predefined setups, meta-labels confidence, verifies risk engine,
 * and generates structured trade proposals for queue placement.
 */
import { loadMetaModel, predictConfidenceBatch } from './mlService';
import * as tf from '@tensorflow/tfjs';

export async function scanSingleMarket(
  symbolConfig: SymbolConfig,
  bars: MarketBar[],
  options: ScanMarketOptions,
  tfjsModel?: tf.LayersModel
): Promise<MarketScanResult> {
  const policy = options.riskPolicy || DEFAULT_RISK_POLICY;
  const currentBar = bars[bars.length - 1];
  const price = currentBar ? currentBar.close : symbolConfig.basePrice;
  const orderBook = generateOrderBook(
    price,
    symbolConfig.tickSize,
    options.failureState.simulateOrderBookThinLiquidity
  );
  const regime: RegimeType = classifyRegime(bars);
  
  const promotedModel = loadStoredPromotedLabModel();

  // Evaluate candidate strategy setups
  const setups = evaluatePredefinedSetups({
    symbol: symbolConfig.symbol,
    timeframe: "5m",
    bars,
    regime,
    eventWindowActive: false,
    promotedModel,
  });

  const qualifiedSetups = setups.filter((s) => s.qualifies);
  const experiences = options.experiences || generateInitialExperienceDatabase();
  const proposals: TradeProposal[] = [];

  // Batch Prediction Preparation
  const candidateFeatures: number[][] = [];
  
  if (tfjsModel) {
     for (const setup of qualifiedSetups) {
        // Build the same 6 features for TFJS Model (ATR, VolSurge, RSI, VWAP_Dist, TimeOfDay, Slope)
        // Note: we can use setup.features values
        const atrScaled = setup.features.atr / price;
        const volSurgeScaled = Math.min(setup.features.volumeSurgeRatio / 5, 1);
        const rsiScaled = setup.features.rsi / 100;
        const vwapDist = setup.features.vwapDistancePercent / 100;
        
        const date = new Date();
        const timeOfDay = date.getUTCHours() / 24;
        
        // estimate slope from regime
        let slope = 0;
        if (regime === "trending_bullish") slope = 0.05;
        else if (regime === "trending_bearish") slope = -0.05;
        
        candidateFeatures.push([atrScaled, volSurgeScaled, rsiScaled, vwapDist, timeOfDay, slope]);
     }
  }

  let predictions: number[] = [];
  if (tfjsModel && candidateFeatures.length > 0) {
     predictions = predictConfidenceBatch(tfjsModel, candidateFeatures);
  }

  for (let i = 0; i < qualifiedSetups.length; i++) {
    const setup = qualifiedSetups[i];
    // 1. Experience Retrieval
    const retrieval = retrieveSimilarExperiences(setup, regime, experiences, 15);

    // 2. Meta-Label Scoring
    const metaScore: MetaLabelScore = computeMetaLabelScore({
      setup,
      regime,
      empiricalWinRate: retrieval.empiricalWinRate,
      sampleCount: retrieval.sampleCount,
      similarityScore: retrieval.similarityScore,
    });

    if (tfjsModel && predictions.length > i) {
      metaScore.confidence = predictions[i];
      metaScore.confidenceRationale = "TensorFlow.js Neural Net Real-time Prediction";
    }

    // 3. Expected Value Assessment
    const evAssessment: ExpectedValueAssessment = evaluateExpectedValue(
      setup,
      metaScore,
      orderBook.spread,
      orderBook.depthScore
    );

    // 4. Deterministic Risk Engine & Bounded Kelly Sizing
    const riskCalc: RiskCalculation = evaluateRiskEngine(
      setup,
      metaScore,
      evAssessment,
      options.activePositions,
      Math.abs(Math.min(0, options.dailyRealizedPnl)),
      orderBook.depthScore,
      2,
      policy,
      options.failureState,
      false
    );

    // Must pass edge criteria, risk constraints, and dynamic confidence hurdle
    const requiredConfidence = promotedModel?.optimizedParameters?.minConfidence ?? 0.58;
    
    if (evAssessment.isPositiveEdge && riskCalc.passedAllChecks && riskCalc.recommendedPositionSizeUnits > 0 && metaScore.confidence >= requiredConfidence) {
      const sanitizedId = symbolConfig.symbol.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      const uniqueSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
      const now = Date.now();
      const expiryMs = 60000; // 60s human approval window

      const proposal: TradeProposal = {
        id: `PROP-${sanitizedId.toUpperCase()}-${uniqueSuffix}`,
        timestamp: new Date(now).toISOString(),
        symbol: symbolConfig.symbol,
        setup,
        regime,
        metaScore,
        evAssessment,
        riskCalc,
        status: "PENDING_APPROVAL",
        approvalExpiryMs: expiryMs,
        expiresAt: now + expiryMs,
        approvalToken: `AUTH-${uniqueSuffix}-${Math.floor(1000 + Math.random() * 9000)}`,
        supervisorNotes: `Market Scan Agent detected ${setup.name} in ${regime.replace(/_/g, " ")}. Meta-confidence ${(metaScore.confidence * 100).toFixed(0)}%, net EV +₹${evAssessment.expectedNetValue.toFixed(2)}. Allocated ${riskCalc.recommendedPositionSizeUnits} units (₹${riskCalc.riskDollars.toFixed(0)} risk). Placed in Queue for human authorization.`,
        marketAnalysisSummary: `Technical indicators show strong regime alignment. Support at ₹${(price * 0.985).toFixed(2)}, Resistance at ₹${(price * 1.015).toFixed(2)}. Spread is ${((orderBook.spread / (orderBook.midPrice || price || 1)) * 100).toFixed(3)}% with depth score ${orderBook.depthScore}/100.`,
        aiRecommendation: metaScore.confidence >= 0.60 ? "TRADE_FAVORED" : "CAUTION",
        modelUsed: "Multi-Agent Scanner Engine v2.0",
        failureConditionRisk: `Adverse move against ${setup.direction} invalidating level @ ₹${setup.stopLoss.toFixed(2)}.`,
      };

      proposals.push(proposal);
    }
  }

  return {
    symbol: symbolConfig.symbol,
    symbolName: symbolConfig.name,
    price,
    regime,
    evaluatedSetupsCount: setups.length,
    qualifiedSetupsCount: qualifiedSetups.length,
    orderBook,
    proposals,
    summaryNote:
      proposals.length > 0
        ? `Found ${proposals.length} high-conviction setup(s) meeting positive EV and Kelly risk criteria.`
        : qualifiedSetups.length > 0
        ? `Setups qualified but filtered out by negative net EV or strict risk engine constraints.`
        : `No strategy setups met qualifying criteria in current ${regime.replace(/_/g, " ")} market.`,
  };
}

/**
 * Scans all supported markets or a chosen subset and aggregates
 * all qualifying trade proposals into the queue.
 */
export async function scanAllMarkets(options: ScanMarketOptions): Promise<FullScanReport> {
  const targetSymbols = options.symbols
    ? SUPPORTED_SYMBOLS.filter((s) => options.symbols!.includes(s.symbol))
    : SUPPORTED_SYMBOLS;

  const resultsBySymbol: MarketScanResult[] = [];
  const newProposals: TradeProposal[] = [];

  let totalSetupsEvaluated = 0;

  const promotedModel = loadStoredPromotedLabModel();
  let tfjsModel: tf.LayersModel | undefined = undefined;
  
  if (promotedModel?.hasTrainedModel) {
    const loaded = await loadMetaModel();
    if (loaded) {
      tfjsModel = loaded;
    }
  }

  for (const symbolConfig of targetSymbols) {
    let bars = options.barsMap && options.barsMap[symbolConfig.symbol]
        ? options.barsMap[symbolConfig.symbol]
        : liveMarketStream.getBars(symbolConfig.symbol);

    if (!bars || bars.length === 0) {
      bars = generateInitialBars(symbolConfig, 75);
    }

    const scanResult = await scanSingleMarket(symbolConfig, bars, options, tfjsModel);
    resultsBySymbol.push(scanResult);
    totalSetupsEvaluated += scanResult.evaluatedSetupsCount;

    for (const prop of scanResult.proposals) {
      newProposals.push(prop);
    }
  }

  // Rank proposals strictly by highest Calibrated Win Probability P(Win), then highest Net EV
  newProposals.sort((a, b) => {
    const probDiff =
      b.metaScore.calibratedWinProbability -
      a.metaScore.calibratedWinProbability;
    if (Math.abs(probDiff) > 0.001) return probDiff;
    return b.evAssessment.expectedNetValue - a.evAssessment.expectedNetValue;
  });

  return {
    timestamp: new Date().toISOString(),
    totalMarketsScanned: targetSymbols.length,
    totalSetupsEvaluated,
    totalProposalsPlacedInQueue: newProposals.length,
    resultsBySymbol,
    newProposals,
  };
}
