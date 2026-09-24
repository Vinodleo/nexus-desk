import {
  ExpectedValueAssessment,
  FailureInjectionState,
  MarketBar,
  MetaLabelScore,
  OrderBook,
  Position,
  PromotedLabModel,
  RegimeType,
  RiskCalculation,
  StrategySetup,
  TradeProposal,
} from "../types";
import {
  SUPPORTED_SYMBOLS,
  isIndianEquityMarketOpen,
  SymbolConfig,
  classifyRegime,
  decorateBarsWithIndicators,
  generateOrderBook,
} from "./marketDataService";
import { runPersonaPanel } from "./personaEngine";
import { liveMarketStream } from "./liveMarketStreamService";
import {
  generateInitialExperienceDatabase,
  retrieveSimilarExperiences,
} from "./experienceMemory";
import { computeMetaLabelScore } from "./metaLabeling";
import { syntheticBarShare } from "./dataProvenance";
import { MIN_SIGNAL_BARS, SIGNAL_INTERVAL, SIGNAL_INTERVAL_MS } from "./liveMarketStreamService";
import { skipReasonForRisk, type SkipReason, type SymbolScanOutcome } from "./scanOutcome";

// A Lab model trained on generated candles says nothing about the real
// market, so the live desk ignores it (default hurdle, no persona tuning, no
// TF.js model) even if an older build let it be promoted.
let warnedSyntheticPromotion = false;
/** The live desk's default bar for meta-label confidence. */
export const DEFAULT_MIN_CONFIDENCE = 0.58;

/**
 * Confidence a setup needs to become a proposal. A promoted Lab model can
 * raise it but never lower it: the Lab's minConfidence is measured on the
 * backtester's own confidence heuristic, a different scale from the live
 * meta-label score, so a lower Lab value would quietly loosen live trading.
 */
export function requiredMetaConfidence(promotedModel: PromotedLabModel | null | undefined): number {
  return Math.max(DEFAULT_MIN_CONFIDENCE, promotedModel?.optimizedParameters?.minConfidence ?? 0);
}

function loadUsablePromotedModel() {
  const model = loadStoredPromotedLabModel();
  if (model?.isSynthetic) {
    if (!warnedSyntheticPromotion) {
      warnedSyntheticPromotion = true;
      console.warn(
        `[Scanner] Ignoring promoted Lab model "${model.datasetName}": it was trained on generated candles. Retrain on real data and promote again.`
      );
    }
    return null;
  }
  return model;
}
import {
  DEFAULT_RISK_POLICY,
  RiskPolicyConfig,
  evaluateExpectedValue,
  evaluateRiskEngine,
} from "./riskEngine";
import { loadStoredPromotedLabModel } from "./storagePersistenceService";
import { loadMetaModel, predictConfidenceBatch } from "./mlService";
import * as tf from "@tensorflow/tfjs";

export interface ScanMarketOptions {
  symbols?: string[];
  barsMap?: Record<string, MarketBar[]>;
  activePositions: Position[];
  dailyRealizedPnl: number;
  failureState: FailureInjectionState;
  riskPolicy?: RiskPolicyConfig;
  experiences?: any[];
  quarantines?: Record<string, { quarantinedUntilMs: number }>;
  /**
   * Skip coins whose latest closed candle was already scanned (the automatic
   * scan after each candle close). A manual scan leaves this off.
   */
  onlyNewCandles?: boolean;
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
  outcome: SymbolScanOutcome;
}

export interface FullScanReport {
  timestamp: string;
  totalMarketsScanned: number;
  totalSetupsEvaluated: number;
  totalProposalsPlacedInQueue: number;
  resultsBySymbol: MarketScanResult[];
  newProposals: TradeProposal[];
  /** One entry per coin scanned: proposed, or why not. */
  outcomes: SymbolScanOutcome[];
}

/**
 * Scans a single market symbol, calculates indicators and regimes,
 * checks predefined setups, meta-labels confidence, verifies risk engine,
 * and generates structured trade proposals for queue placement.
 */
export async function scanSingleMarket(
  symbolConfig: SymbolConfig,
  bars: MarketBar[],
  options: ScanMarketOptions,
  tfjsModel?: tf.LayersModel
): Promise<MarketScanResult> {
  const policy = options.riskPolicy || DEFAULT_RISK_POLICY;
  const currentBar =
    bars && bars.length > 0 ? bars[bars.length - 1] : undefined;
  const price = currentBar ? currentBar.close : symbolConfig.basePrice;
  const orderBook = generateOrderBook(
    price,
    symbolConfig.tickSize,
    options.failureState.simulateOrderBookThinLiquidity
  );
  const regime: RegimeType = classifyRegime(bars);
  const promotedModel = loadUsablePromotedModel();
  // The latest candle closed at open time + interval. If that was more than
  // two intervals ago the feed has stalled, and the risk engine fails closed.
  const candleCloseMs = (currentBar?.timestampMs ?? Date.now()) + SIGNAL_INTERVAL_MS;
  const isDataStale = Date.now() - candleCloseMs > 2 * SIGNAL_INTERVAL_MS;
  const experiences =
    options.experiences || generateInitialExperienceDatabase();
  const proposals: TradeProposal[] = [];

  // Run the full trader panel: multiple differentiated personas vote,
  // suppressor personas (volatility/event risk officers) can veto outright,
  // and genuine disagreement between personas is arbitrated by meta-labeled
  // confidence rather than silently generating contradictory proposals.
  const panel = runPersonaPanel(
    {
      symbol: symbolConfig.symbol,
      timeframe: SIGNAL_INTERVAL,
      bars,
      regime,
      eventWindowActive: false,
      promotedModel,
      macroRegime: liveMarketStream.getMacroRegime(symbolConfig.symbol),
    },
    (setup) => {
      const retrieval = retrieveSimilarExperiences(
        setup,
        regime,
        experiences,
        15
      );
      return computeMetaLabelScore({
        setup,
        regime,
        empiricalWinRate: retrieval.empiricalWinRate,
        sampleCount: retrieval.sampleCount,
        similarityScore: retrieval.similarityScore,
      });
    },
    "intraday"
  );

  // Swing/long-horizon personas (e.g. macro trend followers) run as a
  // completely separate panel — their votes never pool with intraday
  // personas' (see runPersonaPanel), and a symbol can legitimately carry
  // both an intraday setup and a swing setup at once.
  const swingPanel = runPersonaPanel(
    {
      symbol: symbolConfig.symbol,
      timeframe: SIGNAL_INTERVAL,
      bars,
      regime,
      eventWindowActive: false,
      promotedModel,
      macroRegime: liveMarketStream.getMacroRegime(symbolConfig.symbol),
    },
    (setup) => {
      const retrieval = retrieveSimilarExperiences(
        setup,
        regime,
        experiences,
        15
      );
      return computeMetaLabelScore({
        setup,
        regime,
        empiricalWinRate: retrieval.empiricalWinRate,
        sampleCount: retrieval.sampleCount,
        similarityScore: retrieval.similarityScore,
      });
    },
    "swing"
  );

  const candidates: { setup: StrategySetup; panel: typeof panel }[] = [];
  if (panel.setup) candidates.push({ setup: panel.setup, panel });
  if (swingPanel.setup)
    candidates.push({ setup: swingPanel.setup, panel: swingPanel });
  const qualifiedSetups = candidates.map((c) => c.setup);

  // Batch Prediction Preparation
  const candidateFeatures: number[][] = [];
  if (tfjsModel) {
    for (const setup of qualifiedSetups) {
      // Build the same 6 features for TFJS Model (ATR, VolSurge, RSI, VWAP_Dist, TimeOfDay, Slope)
      // Note: we can use setup.features values
      const atrScaled = setup.features.atr / price;
      const volSurgeScaled = Math.min(
        setup.features.volumeSurgeRatio / 5,
        1
      );
      const rsiScaled = setup.features.rsi / 100;
      const vwapDist = setup.features.vwapDistancePercent / 100;
      const date = new Date();
      const timeOfDay = date.getUTCHours() / 24;

      // estimate slope from regime
      let slope = 0;
      if (regime === "trending_bullish") slope = 0.05;
      else if (regime === "trending_bearish") slope = -0.05;

      candidateFeatures.push([
        atrScaled,
        volSurgeScaled,
        rsiScaled,
        vwapDist,
        timeOfDay,
        slope,
      ]);
    }
  }

  let predictions: number[] = [];
  if (tfjsModel && candidateFeatures.length > 0) {
    predictions = predictConfidenceBatch(tfjsModel, candidateFeatures);
  }

  // Why each qualified setup didn't become a proposal, in panel order.
  const candidateSkips: SkipReason[] = [];

  for (let i = 0; i < qualifiedSetups.length; i++) {
    const setup = qualifiedSetups[i];
    const sourcePanel = candidates[i].panel;

    // 1. Experience Retrieval
    const retrieval = retrieveSimilarExperiences(
      setup,
      regime,
      experiences,
      15
    );

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
      metaScore.confidenceRationale =
        "TensorFlow.js Neural Net Real-time Prediction";
    }

    // 3. Expected Value Assessment
    const evAssessment: ExpectedValueAssessment = evaluateExpectedValue(
      setup,
      metaScore,
      orderBook.spread,
      orderBook.depthScore,
      policy
    );

    // 4. Deterministic Risk Engine & Bounded Kelly Sizing
    const symbolQuarantine = options.quarantines?.[symbolConfig.symbol];
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
      isDataStale,
      {
        quarantinedUntilMs: symbolQuarantine?.quarantinedUntilMs,
        spread: orderBook.spread,
      }
    );

    // Must pass edge criteria, risk constraints, and the confidence hurdle.
    const requiredConfidence = requiredMetaConfidence(promotedModel);

    if (!riskCalc.passedAllChecks) {
      candidateSkips.push(skipReasonForRisk(riskCalc.rejectionCode));
    } else if (!evAssessment.isPositiveEdge) {
      candidateSkips.push("negative_ev");
    } else if (riskCalc.recommendedPositionSizeUnits <= 0) {
      candidateSkips.push("below_min_size");
    } else if (metaScore.confidence < requiredConfidence) {
      candidateSkips.push("low_confidence");
    }

    if (
      evAssessment.isPositiveEdge &&
      riskCalc.passedAllChecks &&
      riskCalc.recommendedPositionSizeUnits > 0 &&
      metaScore.confidence >= requiredConfidence
    ) {
      const sanitizedId = symbolConfig.symbol
        .replace(/[^a-zA-Z0-9]/g, "")
        .toLowerCase();
      const uniqueSuffix = Math.random()
        .toString(36)
        .substring(2, 6)
        .toUpperCase();
      const now = Date.now();
      // A signal is good until two more candles have closed after it.
      const expiryMs = Math.max(60000, candleCloseMs + 2 * SIGNAL_INTERVAL_MS - now);

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
        approvalToken: `AUTH-${uniqueSuffix}-${Math.floor(
          1000 + Math.random() * 9000
        )}`,
        supervisorNotes: `Trader panel (${sourcePanel.supportingPersonas.length}/${sourcePanel.totalVotesCast} personas, ${(sourcePanel.agreementScore * 100).toFixed(0)}% weighted agreement) detected ${setup.name} in ${regime.replace(/_/g, " ")}. Meta-confidence ${(metaScore.confidence * 100).toFixed(0)}%, net EV +₹${evAssessment.expectedNetValue.toFixed(2)}. Allocated ${riskCalc.recommendedPositionSizeUnits} units (₹${riskCalc.riskDollars.toFixed(0)} risk). Placed in Queue for human authorization.`,
        marketAnalysisSummary: `Technical indicators show strong regime alignment. Support at ₹${(price * 0.985).toFixed(2)}, Resistance at ₹${(price * 1.015).toFixed(2)}. Spread is ${((orderBook.spread / (orderBook.midPrice || price || 1)) * 100).toFixed(3)}% with depth score ${orderBook.depthScore}/100.`,
        aiRecommendation:
          metaScore.confidence >= 0.60 ? "TRADE_FAVORED" : "CAUTION",
        modelUsed: "Multi-Agent Trader Panel v3.0",
        failureConditionRisk: `Adverse move against ${setup.direction} invalidating level @ ₹${setup.stopLoss.toFixed(2)}.`,
        ensembleAgreement: sourcePanel.agreementScore,
        supportingPersonas: sourcePanel.supportingPersonas,
        dissentingPersonas: sourcePanel.dissentingPersonas,
        personaVotesCast: sourcePanel.totalVotesCast,
        dataQuality: {
          syntheticBarShare: syntheticBarShare(bars),
          seededExperienceShare: retrieval.seededShare,
          // generateOrderBook() models spread/depth; there's no live book feed yet.
          simulatedOrderBook: true,
        },
      };
      proposals.push(proposal);
    }
  }

  const trendFiltered = (panel.filteredByHigherTimeframe ?? 0) + (swingPanel.filteredByHigherTimeframe ?? 0);
  const outcome: SymbolScanOutcome =
    proposals.length > 0
      ? { symbol: symbolConfig.symbol, proposed: true }
      : {
          symbol: symbolConfig.symbol,
          proposed: false,
          reason:
            candidateSkips[0] ??
            (panel.vetoed || swingPanel.vetoed ? "vetoed" : trendFiltered > 0 ? "against_trend" : "no_setup"),
        };

  return {
    outcome,
    symbol: symbolConfig.symbol,
    symbolName: symbolConfig.name,
    price,
    regime,
    evaluatedSetupsCount:
      panel.totalPersonasRun + swingPanel.totalPersonasRun,
    qualifiedSetupsCount: qualifiedSetups.length,
    orderBook,
    proposals,
    summaryNote: panel.vetoed
      ? `Trader panel vetoed this symbol: ${panel.vetoReason}`
      : proposals.length > 0
      ? `Trader panel reached ${(panel.agreementScore * 100).toFixed(0)}% consensus (${panel.supportingPersonas.length}/${panel.totalVotesCast} personas) meeting positive EV and Kelly risk criteria.${swingPanel.setup ? " Swing panel also qualified a long-horizon setup." : ""}`
      : qualifiedSetups.length > 0
      ? `Panel setup qualified but filtered out by negative net EV or strict risk engine constraints.`
      : `No panel consensus met qualifying criteria in current ${regime.replace(/_/g, " ")} market.`,
  };
}

/**
 * Scans all supported markets or a chosen subset and aggregates
 * all qualifying trade proposals into the queue.
 */
/** Open time of the last candle scanned per symbol, for once-per-candle scanning. */
const lastScannedCandle = new Map<string, number>();
/** Candle period in which a coin was last counted as having no data. */
const lastNoDataPeriod = new Map<string, number>();

/** Test hook. */
export function _resetScannedCandles() {
  lastScannedCandle.clear();
  lastNoDataPeriod.clear();
}

export async function scanAllMarkets(
  options: ScanMarketOptions
): Promise<FullScanReport> {
  const targetSymbols = options.symbols
    ? SUPPORTED_SYMBOLS.filter(
        (s) =>
          options.symbols!.includes(s.symbol) ||
          (options.symbols!.includes("XPR/INR") && s.symbol === "XRP/INR")
      )
    : SUPPORTED_SYMBOLS;

  const resultsBySymbol: MarketScanResult[] = [];
  const newProposals: TradeProposal[] = [];
  let totalSetupsEvaluated = 0;

  const promotedModel = loadUsablePromotedModel();
  let tfjsModel: tf.LayersModel | undefined = undefined;

  if (promotedModel?.hasTrainedModel) {
    const loaded = await loadMetaModel();
    if (loaded) {
      tfjsModel = loaded;
    }
  }

  const equityMarketOpen = isIndianEquityMarketOpen();
  const outcomes: SymbolScanOutcome[] = [];

  for (const symbolConfig of targetSymbols) {
    // Equities only get analysed within NSE cash-market hours (9:15-3:30
    // IST, Mon-Fri) — crypto is unaffected, it trades 24/7.
    if (symbolConfig.assetClass === "equity" && !equityMarketOpen) {
      continue;
    }

    const rawBars =
      options.barsMap?.[symbolConfig.symbol] ?? liveMarketStream.getBars(symbolConfig.symbol);
    // The stream's bars already carry indicators; add them if a caller's don't.
    const bars =
      rawBars && rawBars.length > 0 && rawBars[rawBars.length - 1].ema21 === undefined
        ? decorateBarsWithIndicators(rawBars)
        : rawBars;

    // Only real, closed candles are scanned. Without enough of them there's
    // nothing trustworthy to trade on, so the coin is skipped, not faked.
    if (!bars || bars.length < MIN_SIGNAL_BARS || bars.some((b) => b.isSynthetic)) {
      // Automatic scans count a coin without data once per candle, not every
      // time the backstop runs.
      const period = Math.floor(Date.now() / SIGNAL_INTERVAL_MS);
      if (options.onlyNewCandles && lastNoDataPeriod.get(symbolConfig.symbol) === period) continue;
      lastNoDataPeriod.set(symbolConfig.symbol, period);
      outcomes.push({ symbol: symbolConfig.symbol, proposed: false, reason: "no_data" });
      continue;
    }

    // Once per candle: the automatic scan skips a coin whose latest closed
    // candle it has already looked at.
    const latestCandleMs = bars[bars.length - 1].timestampMs;
    if (options.onlyNewCandles && latestCandleMs !== undefined && lastScannedCandle.get(symbolConfig.symbol) === latestCandleMs) {
      continue;
    }
    if (latestCandleMs !== undefined) lastScannedCandle.set(symbolConfig.symbol, latestCandleMs);

    const scanResult = await scanSingleMarket(
      symbolConfig,
      bars,
      options,
      tfjsModel
    );
    resultsBySymbol.push(scanResult);
    outcomes.push(scanResult.outcome);
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
    totalMarketsScanned: outcomes.length,
    totalSetupsEvaluated,
    totalProposalsPlacedInQueue: newProposals.length,
    resultsBySymbol,
    newProposals,
    outcomes,
  };
}
