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
  getSymbolConfig,
  isCryptoInrSymbol,
} from "./marketDataService";
import { runPersonaPanel } from "./personaEngine";
import { liveMarketStream } from "./liveMarketStreamService";
import { retrieveSimilarExperiences } from "./experienceMemory";
import { computeMetaLabelScore } from "./metaLabeling";
import { syntheticBarShare } from "./dataProvenance";
import { MIN_SIGNAL_BARS, SIGNAL_INTERVAL, SIGNAL_INTERVAL_MS } from "./liveMarketStreamService";
import { skipReasonForRisk, type SkipReason, type SymbolScanOutcome } from "./scanOutcome";
import { shadowFromSetup, type ShadowSignal } from "./shadowTracker";
import { DEFAULT_MIN_CONFIDENCE, HEURISTIC_SCORE_VERSION, MIN_EDGE_R, type Calibrator, type ConfidenceScorer } from "./calibration";
import { META_FEATURE_VERSION, metaFeatures } from "./metaFeatures";

// A Lab model trained on generated candles says nothing about the real
// market, so the live desk ignores it (default hurdle, no persona tuning, no
// TF.js model) even if an older build let it be promoted.
let warnedSyntheticPromotion = false;
let warnedStaleModelFeatures = false;
export { DEFAULT_MIN_CONFIDENCE, MIN_EDGE_R };

/**
 * Confidence a setup needs to become a proposal. A promoted Lab model can
 * raise it but never lower it: the Lab's minConfidence is measured on the
 * backtester's own confidence heuristic, a different scale from the live
 * meta-label score, so a lower Lab value would quietly loosen live trading.
 */
export function requiredMetaConfidence(promotedModel: PromotedLabModel | null | undefined): number {
  return Math.max(DEFAULT_MIN_CONFIDENCE, promotedModel?.optimizedParameters?.minConfidence ?? 0);
}

function loadUsablePromotedModel(options?: Pick<ScanMarketOptions, "promotedModel">) {
  const model = options && "promotedModel" in options ? options.promotedModel ?? null : loadStoredPromotedLabModel();
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

const formatInr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;

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
  /**
   * Reads CoinDCX's live order book for a crypto symbol, for a trade worth
   * `notional` rupees. Called only for coins with a setup. Without it, or if
   * it returns null, spread and depth are simulated.
   */
  getOrderBook?: (symbol: string, notional: number) => Promise<OrderBook | null>;
  /**
   * Set when scanning away from the browser (the server): the promoted Lab
   * settings (null for none) instead of this browser's saved ones, the 1-hour
   * trend per symbol, the crypto coins to scan, and whether to load the Lab's
   * TensorFlow model (kept in the browser).
   */
  promotedModel?: PromotedLabModel | null;
  macroRegimes?: Record<string, RegimeType | "neutral">;
  cryptoSymbols?: string[];
  useLabModel?: boolean;
  /** Win-chance calibration from shadow-tracked setups, per scorer. Without one, raw scores are used. */
  calibrators?: Partial<Record<ConfidenceScorer, Calibrator>>;
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
  /** Every setup found this candle, taken or not, for shadow tracking. */
  shadows: ShadowSignal[];
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
  shadows: ShadowSignal[];
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
  // CoinDCX's INR markets are spot: only long trades can be placed there.
  const longOnly = symbolConfig.assetClass === "crypto";
  const currentBar =
    bars && bars.length > 0 ? bars[bars.length - 1] : undefined;
  const price = currentBar ? currentBar.close : symbolConfig.basePrice;
  let orderBook: OrderBook = generateOrderBook(
    price,
    symbolConfig.tickSize,
    options.failureState.simulateOrderBookThinLiquidity
  );
  const regime: RegimeType = classifyRegime(bars);
  const promotedModel = loadUsablePromotedModel(options);
  // The latest candle closed at open time + interval. If that was more than
  // two intervals ago the feed has stalled, and the risk engine fails closed.
  const candleCloseMs = (currentBar?.timestampMs ?? Date.now()) + SIGNAL_INTERVAL_MS;
  const isDataStale = Date.now() - candleCloseMs > 2 * SIGNAL_INTERVAL_MS;
  // No generated starter trades: without a memory, each trader's own
  // estimate stands (see computeMetaLabelScore).
  const experiences = options.experiences ?? [];
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
      longOnly,
      promotedModel,
      macroRegime: options.macroRegimes?.[symbolConfig.symbol] ?? liveMarketStream.getMacroRegime(symbolConfig.symbol),
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
      longOnly,
      promotedModel,
      macroRegime: options.macroRegimes?.[symbolConfig.symbol] ?? liveMarketStream.getMacroRegime(symbolConfig.symbol),
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

  // Real spread and depth for coins with a setup. The thin-liquidity drill
  // keeps the simulated book so it still exercises the liquidity check.
  if (
    qualifiedSetups.length > 0 &&
    options.getOrderBook &&
    symbolConfig.assetClass !== "equity" &&
    !options.failureState.simulateOrderBookThinLiquidity
  ) {
    const live = await options.getOrderBook(symbolConfig.symbol, policy.maxOrderValueInr);
    if (live) orderBook = live;
  }

  // The Lab model's inputs, read from the signal candle the same way the Lab
  // and online learning compute them. Also kept on each shadow for training.
  const signalFeatures = metaFeatures(bars);
  const candidateFeatures: number[][] = tfjsModel ? qualifiedSetups.map(() => signalFeatures) : [];

  let predictions: number[] = [];
  if (tfjsModel && candidateFeatures.length > 0) {
    predictions = predictConfidenceBatch(tfjsModel, candidateFeatures);
  }

  // Why each qualified setup didn't become a proposal, in panel order.
  const candidateSkips: SkipReason[] = [];
  const shadows: ShadowSignal[] = [];

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

    const scorer: ConfidenceScorer = tfjsModel && predictions.length > i ? "tfjs" : "heuristic";
    if (scorer === "tfjs") {
      metaScore.confidence = predictions[i];
      metaScore.confidenceRationale =
        "TensorFlow.js Neural Net Real-time Prediction";
    }

    // Once enough shadow-tracked setups have played out, the win chance used
    // for the profit check and sizing is the one measured at this score.
    const calibrator = setup.horizon === "swing" ? undefined : options.calibrators?.[scorer];
    const calibrated = calibrator?.ready === true;
    if (calibrated) {
      const p = Number(calibrator.calibrate(metaScore.confidence).toFixed(3));
      metaScore.calibratedWinProbability = p;
      metaScore.confidenceRationale = `${metaScore.confidenceRationale} Measured win chance at this score: ${Math.round(p * 100)}% (from ${calibrator.samples} tracked setups).`;
    }

    // 3. Expected Value Assessment
    const evAssessment: ExpectedValueAssessment = evaluateExpectedValue(
      setup,
      metaScore,
      orderBook.spread,
      orderBook.depthScore,
      policy,
      orderBook.roundTripSlippage
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
    // With a measured win chance the hurdle is a real edge: at least
    // MIN_EDGE_R of the risk expected back after costs. Before that, the
    // raw score has to clear the fixed bar. A promoted Lab model's bar
    // applies either way.
    const requiredConfidence = requiredMetaConfidence(promotedModel);
    const passesConfidence = calibrated
      ? evAssessment.expectedNetValue >= MIN_EDGE_R * evAssessment.avgLossDollars &&
        metaScore.confidence >= (promotedModel?.optimizedParameters?.minConfidence ?? 0)
      : metaScore.confidence >= requiredConfidence;

    const skipsBefore = candidateSkips.length;
    if (!riskCalc.passedAllChecks) {
      candidateSkips.push(skipReasonForRisk(riskCalc.rejectionCode));
    } else if (!evAssessment.isPositiveEdge) {
      candidateSkips.push("negative_ev");
    } else if (riskCalc.recommendedPositionSizeUnits <= 0) {
      candidateSkips.push("below_min_size");
    } else if (!passesConfidence) {
      candidateSkips.push("low_confidence");
    }
    shadows.push(
      shadowFromSetup(
        setup,
        candidateSkips.length > skipsBefore ? candidateSkips[candidateSkips.length - 1] : "proposed",
        candleCloseMs,
        {
          confidence: metaScore.confidence,
          scorer,
          scoreVersion: scorer === "heuristic" ? HEURISTIC_SCORE_VERSION : undefined,
          features: signalFeatures,
          regime,
        }
      )
    );

    if (
      evAssessment.isPositiveEdge &&
      riskCalc.passedAllChecks &&
      riskCalc.recommendedPositionSizeUnits > 0 &&
      passesConfidence
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
        marketAnalysisSummary: `Technical indicators show strong regime alignment. Support at ₹${(price * 0.985).toFixed(2)}, Resistance at ₹${(price * 1.015).toFixed(2)}. ${orderBook.source === "coindcx" ? "CoinDCX order book: spread" : "Estimated spread"} ${((orderBook.spread / (orderBook.midPrice || price || 1)) * 100).toFixed(3)}%, depth score ${orderBook.depthScore}/100${orderBook.depthInr !== undefined ? ` (${formatInr(orderBook.depthInr)} within 0.5% of the price)` : ""}.`,
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
          simulatedOrderBook: orderBook.source !== "coindcx",
        },
      };
      proposals.push(proposal);
    }
  }

  const trendFiltered = (panel.filteredByHigherTimeframe ?? 0) + (swingPanel.filteredByHigherTimeframe ?? 0);
  const shortOnly = [...(panel.shortOnlySetups ?? []), ...(swingPanel.shortOnlySetups ?? [])];
  const outcome: SymbolScanOutcome =
    proposals.length > 0
      ? { symbol: symbolConfig.symbol, proposed: true }
      : {
          symbol: symbolConfig.symbol,
          proposed: false,
          reason:
            candidateSkips[0] ??
            (panel.vetoed || swingPanel.vetoed
              ? "vetoed"
              : trendFiltered > 0
              ? "against_trend"
              : shortOnly.length > 0
              ? "no_shorting"
              : "no_setup"),
        };

  for (const setup of [...(panel.trendFilteredSetups ?? []), ...(swingPanel.trendFilteredSetups ?? [])]) {
    shadows.push(shadowFromSetup(setup, "against_trend", candleCloseMs, { features: signalFeatures, regime }));
  }
  // Shorts can't be placed here, but following them shows what they'd have
  // done (for exits, and for when shorting becomes possible).
  for (const setup of shortOnly) {
    shadows.push(shadowFromSetup(setup, "no_shorting", candleCloseMs, { features: signalFeatures, regime }));
  }

  return {
    shadows,
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
  // The crypto coins come from the live stream's list (CoinDCX's most traded
  // INR coins); stocks from the fixed list.
  const universe = [
    ...(options.cryptoSymbols ?? liveMarketStream.getCryptoSymbols()).map(getSymbolConfig),
    ...SUPPORTED_SYMBOLS.filter((s) => s.assetClass === "equity"),
  ];
  const targetSymbols = options.symbols
    ? [...new Set(options.symbols.map((s) => (s === "XPR/INR" ? "XRP/INR" : s)))]
        .filter((s) => SUPPORTED_SYMBOLS.some((c) => c.symbol === s) || isCryptoInrSymbol(s))
        .map(getSymbolConfig)
    : universe;

  const resultsBySymbol: MarketScanResult[] = [];
  const newProposals: TradeProposal[] = [];
  let totalSetupsEvaluated = 0;

  const promotedModel = loadUsablePromotedModel(options);
  let tfjsModel: tf.LayersModel | undefined = undefined;

  // A model trained on another version of the inputs would be fed numbers
  // it doesn't understand, so it's left out until the Lab is rerun.
  if (promotedModel?.hasTrainedModel && promotedModel.featureVersion !== META_FEATURE_VERSION) {
    if (!warnedStaleModelFeatures) {
      warnedStaleModelFeatures = true;
      console.warn(`[Scanner] The promoted Lab model uses older inputs; retrain it in the Lab to use it live.`);
    }
  } else if (promotedModel?.hasTrainedModel && options.useLabModel !== false) {
    const loaded = await loadMetaModel();
    if (loaded) {
      tfjsModel = loaded;
    }
  }

  const equityMarketOpen = isIndianEquityMarketOpen();
  const outcomes: SymbolScanOutcome[] = [];
  const shadows: ShadowSignal[] = [];

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
    // Stocks have no 5-minute candle source yet (they need Zerodha's
    // intraday candles); leave them out rather than report them every scan.
    if (symbolConfig.assetClass === "equity" && (!bars || bars.length === 0)) {
      continue;
    }
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
    shadows.push(...scanResult.shadows);
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
    shadows,
  };
}
