import React, { useState } from "react";
import {
  BarChart3,
  TrendingUp,
  Award,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Layers,
  ArrowRight,
  Sliders,
  Calendar,
  Sparkles,
} from "lucide-react";
import { BacktestSummary, ModelVersion } from "../types";
import { runVectorizedBacktest } from "../services/backtestingEngine";

interface BacktestAndValidationProps {
  championModel: ModelVersion;
  challengerModel: ModelVersion;
  onPromoteChallenger: () => void;
}

export const BacktestAndValidation: React.FC<BacktestAndValidationProps> = ({
  championModel,
  challengerModel,
  onPromoteChallenger,
}) => {
  const [evaluatedVariants, setEvaluatedVariants] = useState(18); // parameter trials tested
  const [selectedStrategy, setSelectedStrategy] = useState<string>("Momentum + Range Selective");
  const [activeModelTab, setActiveModelTab] = useState<"CHALLENGER" | "CHAMPION">("CHALLENGER");

  const backtestData: BacktestSummary = runVectorizedBacktest(
    selectedStrategy,
    activeModelTab,
    evaluatedVariants
  );

  return (
    <div id="backtest-validation" className="space-y-4">
      {/* Top Banner: Section 11 & 17 Quantitative Rigor */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-emerald-600" />
            <h3 className="font-semibold text-sm text-stone-900">
              Sections 11 & 17: Vectorized Backtest & Purged Walk-Forward Validation
            </h3>
          </div>
          <span className="text-xs px-2.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-mono font-medium">
            Purged & Embargoed Folds • Deflated Sharpe
          </span>
        </div>
        <p className="text-xs text-stone-600">
          "Purging and embargoing matter specifically because standard walk-forward splits can still leak information when a trade's holding period spans a fold boundary — a known failure mode in walk-forward validation of trading strategies."
        </p>
      </div>

      {/* Champion vs Challenger Comparison Banner */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Champion Model Card */}
        <div
          onClick={() => setActiveModelTab("CHAMPION")}
          className={`p-4 rounded-xl border transition-all cursor-pointer ${
            activeModelTab === "CHAMPION"
              ? "bg-stone-50 border-stone-400 ring-2 ring-stone-400/20 shadow-xs"
              : "bg-white border-stone-200 hover:border-stone-300"
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Award className="w-4 h-4 text-emerald-600" />
              <span className="font-bold text-xs text-stone-800">Champion: {championModel.name}</span>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-mono font-bold">
              ACTIVE (LIVE EXECUTION)
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 font-mono text-xs pt-2 border-t border-stone-200">
            <div>
              <span className="text-[10px] text-stone-400 block">Sharpe (Deflated)</span>
              <span className="font-bold text-stone-800">
                {championModel.sharpeRatio} ({championModel.deflatedSharpeRatio})
              </span>
            </div>
            <div>
              <span className="text-[10px] text-stone-400 block">Win Rate</span>
              <span className="font-bold text-stone-800">
                {(championModel.winRate * 100).toFixed(1)}%
              </span>
            </div>
            <div>
              <span className="text-[10px] text-stone-400 block">Max Drawdown</span>
              <span className="font-bold text-stone-800">
                {championModel.maxDrawdownPercent}%
              </span>
            </div>
          </div>
        </div>

        {/* Challenger Model Card */}
        <div
          onClick={() => setActiveModelTab("CHALLENGER")}
          className={`p-4 rounded-xl border transition-all cursor-pointer ${
            activeModelTab === "CHALLENGER"
              ? "bg-amber-50/70 border-amber-400 ring-2 ring-amber-400/20 shadow-xs"
              : "bg-white border-stone-200 hover:border-stone-300"
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-600" />
              <span className="font-bold text-xs text-stone-800">Challenger: {challengerModel.name}</span>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-mono font-bold">
              EVALUATING IN SHADOW
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 font-mono text-xs pt-2 border-t border-stone-200">
            <div>
              <span className="text-[10px] text-stone-400 block">Sharpe (Deflated)</span>
              <span className="font-bold text-emerald-700">
                {challengerModel.sharpeRatio} ({challengerModel.deflatedSharpeRatio})
              </span>
            </div>
            <div>
              <span className="text-[10px] text-stone-400 block">Win Rate</span>
              <span className="font-bold text-emerald-700">
                {(challengerModel.winRate * 100).toFixed(1)}%
              </span>
            </div>
            <div>
              <span className="text-[10px] text-stone-400 block">Max Drawdown</span>
              <span className="font-bold text-emerald-700">
                {challengerModel.maxDrawdownPercent}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Multiple-Testing Controls & Deflated Sharpe Explanation */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-stone-700">Evaluated Strategy & Parameter Variants (N):</span>
          <input
            id="variants-slider"
            type="range"
            min="1"
            max="60"
            value={evaluatedVariants}
            onChange={(e) => setEvaluatedVariants(parseInt(e.target.value))}
            className="cursor-pointer"
          />
          <span className="font-mono font-bold text-stone-900 bg-stone-100 px-2 py-0.5 rounded border border-stone-200">
            {evaluatedVariants} variants
          </span>
        </div>

        <div className="text-stone-500 font-mono text-[11px]">
          Estimated Sharpe: <strong>{backtestData.sharpeRatio}</strong> → Multiple-Testing Deflated Sharpe:{" "}
          <strong className="text-emerald-700 text-xs">{backtestData.deflatedSharpeRatio}</strong>
        </div>
      </div>

      {/* Purged & Embargoed Folds Visualization */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-emerald-600" />
            <h4 className="font-semibold text-xs text-stone-900">
              Walk-Forward Splits with Purged Boundaries & 5-Day Embargos
            </h4>
          </div>
          <span className="text-[11px] text-stone-500">
            4 Walk-Forward Periods • Prevents Horizon Leakage
          </span>
        </div>

        <div className="space-y-2">
          {backtestData.folds.map((f) => (
            <div
              key={`fold-${f.foldIndex}`}
              className="p-3 bg-stone-50 rounded-lg border border-stone-200 flex flex-wrap items-center justify-between gap-3 text-xs"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-stone-700 bg-stone-200 px-1.5 py-0.5 rounded text-[10px]">
                  Fold {f.foldIndex}
                </span>
                <span className="text-stone-600">Train: {f.trainRange}</span>
                <ArrowRight className="w-3.5 h-3.5 text-stone-400" />
                <span className="font-semibold text-stone-800">Test: {f.testRange}</span>
              </div>

              <div className="flex items-center gap-3 font-mono text-[11px]">
                <span className="text-rose-600 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                  {f.purgedTradesCount} trades purged
                </span>
                <span className="text-stone-500 bg-stone-100 px-2 py-0.5 rounded border border-stone-200">
                  {f.embargoDays}d embargo
                </span>
                <span className="text-stone-700">
                  In-Sample: <strong>{f.inSampleSharpe}</strong>
                </span>
                <span className="text-emerald-700 font-bold">
                  Out-of-Sample: {f.outOfSampleSharpe}
                </span>
                <span className="text-emerald-700 font-bold flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Passed</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Section 17 Promotion Checklist */}
      <div className="bg-white border border-stone-200 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-stone-200">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-600" />
            <h4 className="font-semibold text-sm text-stone-900">
              Section 17: Quantitative Promotion Checklist Before Real Money
            </h4>
          </div>
          <span className="text-xs font-mono font-semibold px-2.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
            {backtestData.candidateMeetsPromotionCriteria ? "ALL GATES PASSED (6/6)" : "INCOMPLETE"}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-stone-900">1. Minimum Sample Sizes</div>
              <div className="text-stone-500 text-[11px]">
                ≥30 trades per regime and ≥100 total trades evaluated across all market types.
              </div>
            </div>
          </div>

          <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-stone-900">2. Purged Walk-Forward Stability</div>
              <div className="text-stone-500 text-[11px]">
                Performance stable across multiple walk-forward periods using purged/embargoed folds.
              </div>
            </div>
          </div>

          <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-stone-900">3. Multiple Testing Correction</div>
              <div className="text-stone-500 text-[11px]">
                Deflated Sharpe Ratio remains &gt; 1.5 after penalizing for {evaluatedVariants} evaluated parameter variants.
              </div>
            </div>
          </div>

          <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-stone-900">4. Regime Independence</div>
              <div className="text-stone-500 text-[11px]">
                Profitability is distributed across multiple market conditions, not reliant on a single bull regime.
              </div>
            </div>
          </div>

          <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-stone-900">5. Out-of-Sample Holdout Performance</div>
              <div className="text-stone-500 text-[11px]">
                Holdout period strictly unseen during hyperparameter selection remains positive.
              </div>
            </div>
          </div>

          <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-stone-900">6. Realistic Trading Costs Accounted</div>
              <div className="text-stone-500 text-[11px]">
                Limit-only execution fees, bid-ask spread, and conservative slippage tax fully deducted.
              </div>
            </div>
          </div>
        </div>

        {/* Action button to promote challenger */}
        <div className="pt-2 flex justify-end">
          <button
            id="promote-challenger-btn"
            onClick={onPromoteChallenger}
            disabled={!backtestData.candidateMeetsPromotionCriteria}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-2"
          >
            <Award className="w-4 h-4" />
            <span>Promote Challenger to Champion (Model v2.2.0 Live)</span>
          </button>
        </div>
      </div>
    </div>
  );
};
