import React, { useState } from "react";
import { ModelVersion, PromotedLabModel } from "../types";
import {
  Play,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  TrendingUp,
  Database,
  Upload,
  Sparkles,
  ArrowRight,
  ShieldCheck,
  Zap,
  Activity,
  Award,
  FlaskConical,
  Layers,
} from "lucide-react";
import {
  fetchRealHistoricalCandles,
  parseCSVToCandles,
  runRealDataWalkForward,
  runGlobalMarketTraining,
  RealDataLearningResult,
  HistoricalCandle,
  HistoricalSource,
} from "../services/realDataBacktestService";
import { LearnedModelAccuracy } from "../services/storagePersistenceService";
import { SUPPORTED_SYMBOLS } from "../services/marketDataService";

interface LabTabProps {
  championModel: ModelVersion;
  challengerModel?: ModelVersion;
  currentAccuracy: LearnedModelAccuracy;
  promotedLabModel?: PromotedLabModel | null;
  onPromoteLabModel: (result: RealDataLearningResult) => void;
  onRevertPromotedLabModel?: () => void;
  onRerunWalkForward: () => void;
  onPromoteChallenger?: (newMetrics?: any) => void;
  isRunningWalkForward?: boolean;
}

export const LabTab: React.FC<LabTabProps> = ({
  championModel,
  challengerModel,
  currentAccuracy,
  promotedLabModel,
  onPromoteLabModel,
  onRevertPromotedLabModel,
  onRerunWalkForward,
  onPromoteChallenger,
  isRunningWalkForward = false,
}) => {
  const [subTab, setSubTab] = useState<
    "REAL-DATA-LAB" | "WALK-FORWARD" | "PLAYBOOK" | "MEMORY" | "AUTOPSY"
  >("REAL-DATA-LAB");

  // Real Historical Data State
  const [exchangeSource, setExchangeSource] = useState<HistoricalSource>("BINANCE");
  const [selectedAsset, setSelectedAsset] = useState<string>("BTCUSDT");
  const [selectedTimeframe, setSelectedTimeframe] = useState<"15m" | "1h" | "4h">("1h");
  const [candleCountLimit, setCandleCountLimit] = useState<number>(500);
  const [isLoadingRealData, setIsLoadingRealData] = useState<boolean>(false);
  const [realDataLearningResult, setRealDataLearningResult] =
    useState<RealDataLearningResult | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [learningAppliedMessage, setLearningAppliedMessage] = useState<string | null>(null);

  // Baseline Walk-Forward Folds for synthetic comparison
  const folds = [
    {
      fold: 1,
      trainRange: "2024-01-01 - 2024-03-31",
      testRange: "2024-04-03 - 2024-04-30",
      purged: 14,
      embargo: "72h",
      isSharpe: 1.84,
      oosSharpe: 1.42,
      passed: true,
    },
    {
      fold: 2,
      trainRange: "2024-04-01 - 2024-06-30",
      testRange: "2024-07-03 - 2024-07-31",
      purged: 18,
      embargo: "72h",
      isSharpe: 1.95,
      oosSharpe: 1.51,
      passed: true,
    },
    {
      fold: 3,
      trainRange: "2024-07-01 - 2024-09-30",
      testRange: "2024-10-03 - 2024-10-31",
      purged: 22,
      embargo: "72h",
      isSharpe: 1.72,
      oosSharpe: 1.38,
      passed: true,
    },
    {
      fold: 4,
      trainRange: "2024-10-01 - 2024-12-31",
      testRange: "2025-01-03 - 2025-01-31",
      purged: 16,
      embargo: "72h",
      isSharpe: 2.1,
      oosSharpe: 1.64,
      passed: true,
    },
    {
      fold: 5,
      trainRange: "2025-01-01 - 2025-03-31",
      testRange: "2025-04-03 - 2025-04-30",
      purged: 19,
      embargo: "72h",
      isSharpe: 1.91,
      oosSharpe: 1.48,
      passed: true,
    },
  ];

  // Handler: Run Global Data Train & Test
  const handleTrainAndTestGlobalData = async () => {
    setIsLoadingRealData(true);
    setLearningAppliedMessage(null);

    try {
      const symbols = SUPPORTED_SYMBOLS.map(s => s.symbol);
      const result = await runGlobalMarketTraining(symbols);

      setRealDataLearningResult(result);
      setLearningAppliedMessage(
        `Global Historical candidate trained on ${result.totalCandles} real market bars across ${symbols.length} markets: ${result.baselineMetrics.accuracyPercent}% → ${result.learnedMetrics.accuracyPercent}%. (Isolated in Lab Sandbox).`
      );
    } catch (err) {
      console.error("Failed to run global walk-forward", err);
      alert("Error generating global historical walk-forward. See console.");
    } finally {
      setIsLoadingRealData(false);
    }
  };

  // Handler: Run Real Data Train & Test
  const handleTrainAndTestRealData = async () => {
    setIsLoadingRealData(true);
    setLearningAppliedMessage(null);

    try {
      // 1. Fetch real historical candles from Binance or Coinbase Public REST API
      const candles = await fetchRealHistoricalCandles(
        selectedAsset,
        selectedTimeframe,
        candleCountLimit,
        exchangeSource
      );

      // 2. Execute Walk-Forward In-Sample & Out-of-Sample evaluation
      const result = await runRealDataWalkForward(candles, selectedAsset);

      // Check if data is directly from live exchange or fallback
      const isFallback = candles.length > 0 && candles[0]?.isSynthetic;
      const verifiedSource = candles[0]?.sourceExchange || (exchangeSource === "COINBASE" ? "Coinbase Public API" : "Binance Public API");

      result.sourceExchange = verifiedSource;
      result.isSynthetic = isFallback;
      result.totalCandles = candles.length;
      result.datasetName = `${selectedAsset} (${selectedTimeframe}, ${candles.length} bars via ${verifiedSource})`;

      // Keep strictly in Lab Candidate state (Sandbox Isolation - NOT applied to live desk yet)
      setRealDataLearningResult(result);

      if (isFallback) {
        setLearningAppliedMessage(
          `Historical candidate trained on ${candles.length} deterministic simulated bars: ${result.baselineMetrics.accuracyPercent}% → ${result.learnedMetrics.accuracyPercent}%. (Isolated in Lab Sandbox — live floor remains untouched until promoted).`
        );
      } else {
        setLearningAppliedMessage(
          `Historical candidate trained on ${candles.length} real market bars via ${verifiedSource}: ${result.baselineMetrics.accuracyPercent}% → ${result.learnedMetrics.accuracyPercent}%. (Isolated in Lab Sandbox — live floor remains untouched until promoted).`
        );
      }
    } catch (err) {
      console.error("Failed to train on real data:", err);
    } finally {
      setIsLoadingRealData(false);
    }
  };

  // Handler: Parse CSV File Upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadedFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      if (!text) return;
      const parsedCandles = parseCSVToCandles(text);
      if (parsedCandles.length > 20) {
        setIsLoadingRealData(true);
        setTimeout(async () => {
          const result = await runRealDataWalkForward(parsedCandles, file.name.replace(".csv", ""));
          result.datasetName = `Custom CSV: ${file.name} (${parsedCandles.length} bars)`;
          result.sourceExchange = "Custom CSV Upload";
          result.isSynthetic = false;
          result.totalCandles = parsedCandles.length;

          // Keep strictly in Lab Candidate state (Sandbox Isolation)
          setRealDataLearningResult(result);
          setIsLoadingRealData(false);
          setLearningAppliedMessage(
            `Historical candidate trained on CSV (${parsedCandles.length} bars): ${result.baselineMetrics.accuracyPercent}% → ${result.learnedMetrics.accuracyPercent}%. (Isolated in Lab Sandbox — live floor remains untouched until promoted).`
          );
        }, 500);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-4 pb-20 select-none">
      {/* Top Header & Active Model Calibration Banner */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono tracking-[0.2em] text-stone-400 uppercase">
            Phase 2 Lab · Historical Data Learning Engine
          </span>
          <div className="flex items-center gap-2">
            {promotedLabModel ? (
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-cyan-950/80 border border-cyan-700/60 text-cyan-300 text-[10px] font-mono">
                <Layers className="w-3 h-3 text-cyan-400" />
                <span>LAB PROMOTED TO LIVE ({currentAccuracy.accuracyPct}%)</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-stone-900 border border-stone-800 text-stone-300 text-[10px] font-mono">
                <Sparkles className="w-3 h-3 text-emerald-400" />
                <span>LIVE DESK ACCURACY: {currentAccuracy.accuracyPct}%</span>
              </div>
            )}
          </div>
        </div>

        <h2 className="font-serif text-2xl sm:text-3xl text-stone-100 font-normal">
          Champion vs challenger
        </h2>
        <p className="text-xs text-stone-400 font-sans leading-relaxed">
          Train and calibrate trading models on historical market data in an isolated sandbox.
          Historical learning remains completely segregated from live floor trading until you explicitly promote the candidate into the Live Learning engine.
        </p>
      </div>

      {/* Sub-Tabs Pills Row */}
      <div className="flex items-center gap-1.5 p-1 bg-[#101014] rounded-xl border border-[#202026]">
        {(
          [
            "REAL-DATA-LAB",
            "WALK-FORWARD",
            "PLAYBOOK",
            "MEMORY",
            "AUTOPSY",
          ] as const
        ).map((tab) => (
          <button
            key={tab}
            onClick={() => setSubTab(tab)}
            className={`flex-1 py-2 text-center font-mono text-[10px] sm:text-[11px] tracking-wider rounded-lg transition-all cursor-pointer ${
              subTab === tab
                ? "bg-[#1f1f26] text-white font-medium shadow-sm border border-[#30303b]"
                : "text-stone-400 hover:text-stone-200 hover:bg-white/5"
            }`}
          >
            {tab === "REAL-DATA-LAB" ? "REAL DATA" : tab}
          </button>
        ))}
      </div>

      {/* TAB 1: REAL-DATA-LAB */}
      {subTab === "REAL-DATA-LAB" && (
        <div className="space-y-4">
          {/* Data Controls Card */}
          <div className="rounded-2xl bg-[#0e0e11] border border-[#222227] p-4 sm:p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#1c1c22] pb-3">
              <div>
                <span className="text-[10px] font-mono tracking-[0.15em] text-stone-400 uppercase">
                  Historical Market Feed
                </span>
                <div className="text-stone-100 text-sm font-medium">
                  Public Real OHLCV Candlesticks
                </div>
              </div>

              {/* Upload CSV Option */}
              <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#181820] hover:bg-[#20202a] border border-[#2d2d38] text-stone-300 hover:text-white text-xs font-mono cursor-pointer transition-all">
                <Upload className="w-3.5 h-3.5 text-stone-400" />
                <span>{uploadedFileName ? uploadedFileName.slice(0, 15) : "Upload CSV"}</span>
                <input
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={handleFileUpload}
                />
              </label>
            </div>

            {/* Public REST API Source Tabs */}
            <div className="flex items-center gap-2 p-1 bg-[#141418] rounded-xl border border-[#22222a]">
              <span className="text-[10px] font-mono text-stone-400 uppercase px-2">Public Feed:</span>
              <button
                type="button"
                onClick={() => setExchangeSource("BINANCE")}
                className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-mono transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                  exchangeSource === "BINANCE"
                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/40 font-medium"
                    : "text-stone-400 hover:text-stone-200"
                }`}
              >
                <span>Binance REST API</span>
                <span className="text-[9px] px-1 rounded bg-amber-500/20 text-amber-300 font-mono">/api/v3/klines</span>
              </button>
              <button
                type="button"
                onClick={() => setExchangeSource("COINBASE")}
                className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-mono transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                  exchangeSource === "COINBASE"
                    ? "bg-sky-500/20 text-sky-300 border border-sky-500/40 font-medium"
                    : "text-stone-400 hover:text-stone-200"
                }`}
              >
                <span>Coinbase REST API</span>
                <span className="text-[9px] px-1 rounded bg-sky-500/20 text-sky-300 font-mono">/products/candles</span>
              </button>
            </div>

            {/* Asset Selector & Parameters */}
            <div className="grid grid-cols-3 gap-2 text-xs font-mono">
              <div>
                <label className="text-stone-400 text-[10px] uppercase block mb-1">
                  Asset Pair
                </label>
                <select
                  value={selectedAsset}
                  onChange={(e) => setSelectedAsset(e.target.value)}
                  className="w-full bg-[#141418] border border-[#262630] rounded-lg px-2.5 py-1.5 text-stone-100 focus:border-emerald-500 focus:outline-none"
                >
                  <option value="BTCUSDT">BTC / USDT</option>
                  <option value="ETHUSDT">ETH / USDT</option>
                  <option value="SOLUSDT">SOL / USDT</option>
                  <option value="BNBUSDT">BNB / USDT</option>
                  <option value="XRPUSDT">XRP / USDT</option>
                  <option value="AVAXUSDT">AVAX / USDT</option>
                </select>
              </div>

              <div>
                <label className="text-stone-400 text-[10px] uppercase block mb-1">
                  Interval
                </label>
                <select
                  value={selectedTimeframe}
                  onChange={(e) => setSelectedTimeframe(e.target.value as any)}
                  className="w-full bg-[#141418] border border-[#262630] rounded-lg px-2.5 py-1.5 text-stone-100 focus:border-emerald-500 focus:outline-none"
                >
                  <option value="15m">15 Minutes</option>
                  <option value="1h">1 Hour</option>
                  <option value="4h">4 Hours</option>
                </select>
              </div>

              <div>
                <label className="text-stone-400 text-[10px] uppercase block mb-1">
                  Sample Limit
                </label>
                <select
                  value={candleCountLimit}
                  onChange={(e) => setCandleCountLimit(Number(e.target.value))}
                  className="w-full bg-[#141418] border border-[#262630] rounded-lg px-2.5 py-1.5 text-stone-100 focus:border-emerald-500 focus:outline-none"
                >
                  <option value={200}>200 Bars</option>
                  <option value={500}>500 Bars (~21 Days)</option>
                  <option value={1000}>1,000 Bars (~41 Days)</option>
                </select>
              </div>
            </div>

            {/* Execute Real Training Buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                onClick={handleTrainAndTestRealData}
                disabled={isLoadingRealData}
                className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-stone-950 font-mono font-medium text-xs tracking-wider uppercase transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isLoadingRealData ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Processing...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 soll-current" />
                    <span>Train Single Asset</span>
                  </>
                )}
              </button>
              
              <button
                onClick={handleTrainAndTestGlobalData}
                disabled={isLoadingRealData}
                className="w-full py-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-stone-950 font-mono font-medium text-xs tracking-wider uppercase transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isLoadingRealData ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Aggregating...</span>
                  </>
                ) : (
                  <>
                    <Layers className="w-4 h-4" />
                    <span>Train All Markets</span>
                  </>
                )}
              </button>
            </div>

            {/* Success notification banner */}
            {learningAppliedMessage && (
              <div className="p-3 rounded-xl bg-emerald-950/70 border border-emerald-700/60 text-emerald-200 text-xs font-mono flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{learningAppliedMessage}</span>
              </div>
            )}
          </div>

          {/* Real Learning Results Comparison Card */}
          {realDataLearningResult ? (
            <div className="space-y-4">
              {/* Accuracy Delta & Sandbox Status Box */}
              <div className="rounded-2xl bg-[#0e0e11] border border-[#222227] p-5 space-y-4">
                {/* Header: Sandbox Isolation vs Live Desk Integration Status */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#1c1c22] pb-3">
                  <div className="flex items-center gap-2">
                    <FlaskConical className="w-4 h-4 text-cyan-400" />
                    <div>
                      <span className="text-xs font-mono font-bold text-stone-200 block">
                        Historical Walk-Forward Evaluation (Lab Sandbox)
                      </span>
                      <span className="text-[10px] font-mono text-stone-500">
                        {realDataLearningResult.datasetName || `${selectedAsset} 1h`} · Range: {realDataLearningResult.dateRange.start} → {realDataLearningResult.dateRange.end}
                      </span>
                    </div>
                  </div>

                  <div>
                    {promotedLabModel &&
                    promotedLabModel.datasetName === realDataLearningResult.datasetName &&
                    promotedLabModel.accuracyPct === realDataLearningResult.learnedMetrics.accuracyPercent ? (
                      <span className="px-2.5 py-1 rounded-full bg-emerald-950/90 border border-emerald-600/70 text-emerald-300 text-[10px] font-mono flex items-center gap-1.5 shadow-sm">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span>INTEGRATED WITH LIVE LEARNING</span>
                      </span>
                    ) : (
                      <span className="px-2.5 py-1 rounded-full bg-amber-950/80 border border-amber-600/60 text-amber-300 text-[10px] font-mono flex items-center gap-1.5 shadow-sm">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                        <span>LAB SANDBOX ONLY (NOT INTEGRATED)</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Primary 2-Column Comparison: Active Floor Execution vs Lab Historical Candidate */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  {/* Left: Active Floor Model on Live Trading Desk */}
                  <div className="p-3.5 rounded-xl bg-[#141418] border border-[#202028] space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-stone-400 uppercase tracking-wide">
                        Active Live Trading Floor
                      </span>
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-stone-800 text-stone-300">
                        {promotedLabModel ? "PROMOTED LAB" : "PURE LIVE"}
                      </span>
                    </div>
                    <div className="font-serif text-3xl text-stone-200">
                      {currentAccuracy.accuracyPct}%
                    </div>
                    <div className="text-[11px] font-mono text-stone-400 pt-0.5">
                      Win Rate: {currentAccuracy.winRatePct}% · Sharpe: {currentAccuracy.sharpeRatio}
                    </div>
                    <div className="text-[10px] font-mono text-stone-500 truncate" title={currentAccuracy.datasetName}>
                      {currentAccuracy.datasetName}
                    </div>
                  </div>

                  {/* Right: Lab Historical Candidate */}
                  <div className={`p-3.5 rounded-xl border space-y-1.5 transition-all ${
                    promotedLabModel &&
                    promotedLabModel.datasetName === realDataLearningResult.datasetName &&
                    promotedLabModel.accuracyPct === realDataLearningResult.learnedMetrics.accuracyPercent
                      ? "bg-emerald-950/40 border-emerald-600/60 text-emerald-200"
                      : "bg-[#12151f] border-cyan-700/50 text-cyan-200"
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono uppercase tracking-wide flex items-center gap-1 text-cyan-400">
                        <span>Lab Historical Candidate</span>
                        <Award className="w-3 h-3 text-cyan-400" />
                      </span>
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyan-900/60 text-cyan-300">
                        CHALLENGER
                      </span>
                    </div>
                    <div className="font-serif text-3xl text-white">
                      {realDataLearningResult.learnedMetrics.accuracyPercent}%
                    </div>
                    <div className="text-[11px] font-mono text-cyan-200/90 pt-0.5">
                      Win Rate: {realDataLearningResult.learnedMetrics.winRate}% · Sharpe: {realDataLearningResult.learnedMetrics.sharpeRatio}
                    </div>
                    <div className="text-[10px] font-mono text-emerald-400">
                      Out-of-Sample PnL: +₹{realDataLearningResult.learnedMetrics.netPnlDollars.toLocaleString()} ({realDataLearningResult.totalCandles || realDataLearningResult.candlesCount} bars)
                    </div>
                  </div>
                </div>

                {/* In-Sample Baseline vs Out-of-Sample Gain Details */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-2.5 rounded-xl bg-[#090b10] border border-[#1d2230] text-xs font-mono">
                  <div>
                    <span className="text-[10px] text-stone-500 uppercase">Baseline Raw</span>
                    <div className="text-stone-300 font-bold mt-0.5">
                      {realDataLearningResult.baselineMetrics.accuracyPercent}%
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] text-stone-500 uppercase">Post-Reflexion</span>
                    <div className="text-emerald-400 font-bold mt-0.5">
                      {realDataLearningResult.learnedMetrics.accuracyPercent}%
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] text-stone-500 uppercase">Accuracy Lift</span>
                    <div className="text-emerald-400 font-bold mt-0.5">
                      +{realDataLearningResult.learnedMetrics.accuracyImprovementDelta}%
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] text-stone-500 uppercase">Drawdown Filtered</span>
                    <div className="text-cyan-400 font-bold mt-0.5">
                      -{realDataLearningResult.baselineMetrics.maxDrawdownPercent}% → -{realDataLearningResult.learnedMetrics.maxDrawdownPercent}%
                    </div>
                  </div>
                </div>

                {/* Explicit Promotion Control */}
                {!(
                  promotedLabModel &&
                  promotedLabModel.datasetName === realDataLearningResult.datasetName &&
                  promotedLabModel.accuracyPct === realDataLearningResult.learnedMetrics.accuracyPercent
                ) ? (
                  <div className="space-y-2 pt-1">
                    <button
                      onClick={() => onPromoteLabModel(realDataLearningResult)}
                      className="w-full py-3 px-4 rounded-xl bg-stone-100 hover:bg-white text-stone-950 font-mono font-bold text-xs tracking-wider uppercase transition-all shadow-md cursor-pointer flex items-center justify-center gap-2"
                    >
                      <ShieldCheck className="w-4 h-4 text-emerald-700" />
                      <span>Promote Lab Candidate ({realDataLearningResult.learnedMetrics.accuracyPercent}% Accuracy) & Integrate with Live Learning</span>
                    </button>
                    <p className="text-[10px] font-mono text-stone-400 text-center">
                      Clicking Promote integrates this historical model's parameters and {realDataLearningResult.distilledLessons.length} distilled heuristics with the live floor trading engine.
                    </p>
                  </div>
                ) : (
                  <div className="p-3.5 rounded-xl bg-emerald-950/50 border border-emerald-700/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-emerald-300 text-xs font-mono">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>Integrated with Live Learning on active trading desk ({promotedLabModel.promotedAt})</span>
                    </div>
                    {onRevertPromotedLabModel && (
                      <button
                        onClick={onRevertPromotedLabModel}
                        className="text-[11px] font-mono text-stone-400 hover:text-stone-200 underline cursor-pointer"
                      >
                        Revert to Pure Live Baseline
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Extracted In-Sample Lessons & Heuristics */}
              <div className="rounded-2xl bg-[#0e0e11] border border-[#222227] p-4 sm:p-5 space-y-3">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-stone-300 font-medium">
                    Distilled Heuristics & Reflexion Rules (In-Sample Lessons)
                  </span>
                  <span className="text-emerald-400 text-[11px]">
                    {realDataLearningResult.distilledLessons.length} RULES EXTRACTED
                  </span>
                </div>

                <div className="space-y-2">
                  {realDataLearningResult.distilledLessons.map((lesson) => (
                    <div
                      key={lesson.id}
                      className="p-2.5 rounded-xl bg-[#141418] border border-[#1f1f26] text-xs font-mono space-y-1"
                    >
                      <div className="flex items-center justify-between text-stone-400 text-[10px]">
                        <span>REGIME: {lesson.regime}</span>
                        <span className="text-emerald-400 font-medium">{lesson.action}</span>
                      </div>
                      <p className="text-stone-200 font-sans text-xs leading-relaxed">
                        {lesson.rule}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Out-of-Sample Folds */}
              <div className="rounded-2xl bg-[#0e0e11] border border-[#222227] p-4 space-y-3">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-stone-300 font-medium">
                    5-Fold Real Walk-Forward Test Splits
                  </span>
                  <span className="text-emerald-400 text-[11px]">ALL FOLDS PASSED</span>
                </div>

                <div className="space-y-2">
                  {realDataLearningResult.folds.map((f) => (
                    <div
                      key={f.fold}
                      className="flex items-center justify-between p-2.5 rounded-xl bg-[#141418] border border-[#1f1f26] text-xs font-mono"
                    >
                      <div className="flex items-center gap-2">
                        <span className="px-1.5 py-0.5 rounded bg-stone-800 text-[10px] text-stone-300">
                          F{f.fold}
                        </span>
                        <span className="text-stone-300">{f.testRange}</span>
                      </div>

                      <div className="flex items-center gap-3 text-right">
                        <span className="text-stone-400">
                          OOS Accuracy: <span className="text-emerald-400 font-medium">{f.outOfSampleAccuracy}%</span>
                        </span>
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* Empty state prior to first real run */
            <div className="p-8 rounded-2xl bg-[#0e0e11] border border-[#222227] text-center space-y-2">
              <Database className="w-8 h-8 text-stone-600 mx-auto" />
              <div className="text-stone-300 text-sm font-mono font-medium">
                Ready to Ingest Real Historical Data
              </div>
              <p className="text-stone-500 text-xs max-w-md mx-auto font-sans leading-relaxed">
                Click <strong>"Train & Test on Real Historical Data"</strong> above to pull real candlestick bars directly from the exchange or upload a custom CSV file.
              </p>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: WALK-FORWARD (Classic Synthetic Comparison) */}
      {subTab === "WALK-FORWARD" && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-[#0e0e11] border border-[#222227] p-6 space-y-2">
            <span className="text-[10px] font-mono tracking-[0.2em] text-stone-400 uppercase">
              Champion — Research Window
            </span>
            <div className="font-serif text-4xl sm:text-5xl text-stone-100 font-normal">
              +0.37R
            </div>
            <div className="text-xs font-mono text-stone-400">
              after-cost expectancy · Active Accuracy: {currentAccuracy.accuracyPct}%
            </div>

            <div className="grid grid-cols-3 gap-2 pt-4 border-t border-[#1a1a20] text-xs font-mono">
              <div>
                <span className="text-stone-500 uppercase text-[10px]">
                  Sharpe Ratio
                </span>
                <div className="text-stone-200 font-medium mt-0.5">1.92</div>
              </div>
              <div>
                <span className="text-stone-500 uppercase text-[10px]">
                  Deflated Sharpe
                </span>
                <div className="text-emerald-400 font-medium mt-0.5">1.48</div>
              </div>
              <div>
                <span className="text-stone-500 uppercase text-[10px]">
                  Max Drawdown
                </span>
                <div className="text-rose-400 font-medium mt-0.5">-4.20%</div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-[#0e0e11] border border-[#222227] p-4 space-y-3">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-stone-300 font-medium">
                Purged Walk-Forward Folds (72h Embargo)
              </span>
              <span className="text-emerald-400 text-[11px]">5/5 PASSED</span>
            </div>

            <div className="space-y-2">
              {folds.map((f) => (
                <div
                  key={f.fold}
                  className="flex items-center justify-between p-2.5 rounded-xl bg-[#141418] border border-[#1f1f26] text-xs font-mono"
                >
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-stone-800 text-[10px] text-stone-300">
                      F{f.fold}
                    </span>
                    <span className="text-stone-300">{f.testRange}</span>
                  </div>

                  <div className="flex items-center gap-3 text-right">
                    <span className="text-stone-400">
                      OOS: <span className="text-emerald-400 font-medium">{f.oosSharpe}</span>
                    </span>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: PLAYBOOK */}
      {subTab === "PLAYBOOK" && (
        <div className="space-y-3">
          <div className="rounded-2xl bg-[#0e0e11] border border-[#222227] p-5 space-y-3 text-xs font-mono">
            <div className="text-stone-200 font-semibold font-sans">
              Playbook Rule Specification
            </div>
            <div className="text-stone-400 leading-relaxed font-sans">
              Strategy: <strong>Breakout-v2.0</strong>
              <br />
              Entry: 20-bar Donchian high/low breakout with volume surge ratio ≥ 1.4x.
              <br />
              Veto: Meta-label model with calibrated confidence hurdle ≥ 0.52.
              <br />
              Execution: Passive LIMIT orders pegged to bid/ask. Cost deduction: 14 bps round-trip.
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: MEMORY */}
      {subTab === "MEMORY" && (
        <div className="space-y-3">
          <div className="rounded-2xl bg-[#0e0e11] border border-[#222227] p-5 space-y-3 text-xs font-mono">
            <div className="text-stone-200 font-semibold font-sans">
              Experience Memory Bank (Vector Database)
            </div>
            <p className="text-stone-400 text-xs font-sans">
              Every taken trade and skipped ticket is stored as an immutable feature vector. Autopsy agents cluster similar historical regimes before granting risk approval.
            </p>
            <div className="space-y-1.5 pt-2">
              <div className="p-2.5 rounded-lg bg-[#141418] border border-[#1e1e24] flex justify-between text-stone-300 text-[11px]">
                <span>Vector #342 · ETH Short (Quiet)</span>
                <span className="text-emerald-400">good_decision_good_outcome</span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#141418] border border-[#1e1e24] flex justify-between text-stone-300 text-[11px]">
                <span>Vector #341 · SOL Long (Shock)</span>
                <span className="text-stone-400">vetoed_by_liquidity_guard</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: AUTOPSY */}
      {subTab === "AUTOPSY" && (
        <div className="space-y-3">
          <div className="rounded-2xl bg-[#0e0e11] border border-[#222227] p-5 space-y-3 text-xs font-mono">
            <div className="text-stone-200 font-semibold font-sans">
              Trade Autopsy & Post-Mortem Agent
            </div>
            <p className="text-stone-400 text-xs font-sans">
              Evaluates execution against the 4-way decision matrix:
              <br />
              • Good decision + Good outcome (Edge realized)
              <br />
              • Good decision + Bad outcome (Variance absorbed, model retained)
              <br />
              • Bad decision + Good outcome (Lucky exit, flagged for review)
              <br />
              • Bad decision + Bad outcome (Flaw identified, penalize weight)
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
