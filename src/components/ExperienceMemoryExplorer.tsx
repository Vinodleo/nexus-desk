import React, { useState } from "react";
import {
  History,
  Search,
  Filter,
  CheckCircle2,
  XCircle,
  HelpCircle,
  BarChart2,
  Layers,
  Sparkles,
} from "lucide-react";
import { ExperienceVector, RegimeType, StrategyFamily } from "../types";

interface ExperienceMemoryExplorerProps {
  experiences: ExperienceVector[];
}

export const ExperienceMemoryExplorer: React.FC<ExperienceMemoryExplorerProps> = ({
  experiences,
}) => {
  const [selectedFamily, setSelectedFamily] = useState<string>("ALL");
  const [selectedRegime, setSelectedRegime] = useState<string>("ALL");
  const [selectedClassification, setSelectedClassification] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const filtered = experiences.filter((e) => {
    if (selectedFamily !== "ALL" && e.family !== selectedFamily) return false;
    if (selectedRegime !== "ALL" && e.regime !== selectedRegime) return false;
    if (selectedClassification !== "ALL" && e.postClassification !== selectedClassification) return false;
    if (searchQuery && !e.setupName.toLowerCase().includes(searchQuery.toLowerCase()) && !e.symbol.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    return true;
  });

  const totalWins = filtered.filter((e) => e.outcome === "WIN").length;
  const winRate = filtered.length > 0 ? (totalWins / filtered.length) * 100 : 0;

  // 4-Way Classification counts
  const goodGood = experiences.filter((e) => e.postClassification === "good_decision_good_outcome").length;
  const goodBad = experiences.filter((e) => e.postClassification === "good_decision_bad_outcome").length;
  const badGood = experiences.filter((e) => e.postClassification === "bad_decision_good_outcome").length;
  const badBad = experiences.filter((e) => e.postClassification === "bad_decision_bad_outcome").length;

  return (
    <div id="experience-memory-explorer" className="space-y-4">
      {/* Top Banner */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-emerald-600" />
            <h3 className="font-semibold text-sm text-stone-900">
              Section 10 & 14: Experience Memory & Vector Database
            </h3>
          </div>
          <span className="text-xs px-2.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-mono font-medium">
            {experiences.length} Historical Vectors • k-NN Cosine Similarity
          </span>
        </div>
        <p className="text-xs text-stone-600">
          "The system should become better at selecting and managing predefined opportunities through accumulated, validated experience—not by improvising new strategies whenever it loses."
        </p>
      </div>

      {/* 4-Way Decision/Outcome Matrix (Section 10 & 14) */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
        <h4 className="font-semibold text-xs text-stone-900 mb-3 flex items-center gap-1.5">
          <BarChart2 className="w-4 h-4 text-stone-600" />
          <span>Section 10: 4-Way Decision vs Outcome Post-Classification</span>
        </h4>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
            <span className="text-[10px] text-emerald-700 block">Good Decision / Good Outcome</span>
            <div className="text-base font-bold text-emerald-900 mt-1">{goodGood}</div>
            <span className="text-[10px] text-stone-500 font-sans block mt-1">
              Followed edge, rewarded by market.
            </span>
          </div>

          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <span className="text-[10px] text-amber-700 block">Good Decision / Bad Outcome</span>
            <div className="text-base font-bold text-amber-900 mt-1">{goodBad}</div>
            <span className="text-[10px] text-stone-500 font-sans block mt-1">
              Probabilistic variance; rules preserved.
            </span>
          </div>

          <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg">
            <span className="text-[10px] text-indigo-700 block">Bad Decision / Good Outcome</span>
            <div className="text-base font-bold text-indigo-900 mt-1">{badGood}</div>
            <span className="text-[10px] text-stone-500 font-sans block mt-1">
              Dangerous lucky win; flagged in autopsy.
            </span>
          </div>

          <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg">
            <span className="text-[10px] text-rose-700 block">Bad Decision / Bad Outcome</span>
            <div className="text-base font-bold text-rose-900 mt-1">{badBad}</div>
            <span className="text-[10px] text-stone-500 font-sans block mt-1">
              Direct mistake; penalized in meta-model.
            </span>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Family filter */}
          <select
            id="filter-family-select"
            value={selectedFamily}
            onChange={(e) => setSelectedFamily(e.target.value)}
            className="p-1.5 bg-stone-50 border border-stone-300 rounded text-stone-800"
          >
            <option value="ALL">All Strategy Families</option>
            <option value="trend_following">Trend Following</option>
            <option value="breakout_confirmation">Breakout Confirmation</option>
            <option value="mean_reversion">Mean Reversion</option>
          </select>

          {/* Regime filter */}
          <select
            id="filter-regime-select"
            value={selectedRegime}
            onChange={(e) => setSelectedRegime(e.target.value)}
            className="p-1.5 bg-stone-50 border border-stone-300 rounded text-stone-800"
          >
            <option value="ALL">All Market Regimes</option>
            <option value="trending_bullish">Trending Bullish</option>
            <option value="trending_bearish">Trending Bearish</option>
            <option value="ranging_tight">Ranging Tight</option>
            <option value="ranging_wide">Ranging Wide</option>
            <option value="high_volatility_choppy">High Volatility Choppy</option>
          </select>

          {/* Classification filter */}
          <select
            id="filter-class-select"
            value={selectedClassification}
            onChange={(e) => setSelectedClassification(e.target.value)}
            className="p-1.5 bg-stone-50 border border-stone-300 rounded text-stone-800"
          >
            <option value="ALL">All Classifications</option>
            <option value="good_decision_good_outcome">Good Dec / Good Outcome</option>
            <option value="good_decision_bad_outcome">Good Dec / Bad Outcome</option>
            <option value="bad_decision_good_outcome">Bad Dec / Good Outcome</option>
            <option value="bad_decision_bad_outcome">Bad Dec / Bad Outcome</option>
          </select>
        </div>

        <div className="flex items-center gap-3">
          <div className="font-mono text-stone-600">
            Matching: <strong>{filtered.length}</strong> • Win Rate: <strong>{winRate.toFixed(1)}%</strong>
          </div>
        </div>
      </div>

      {/* Experiences Table */}
      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden shadow-xs">
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-left text-xs">
            <thead className="bg-stone-50 border-b border-stone-200 text-stone-600 font-mono sticky top-0">
              <tr>
                <th className="p-3">ID / Time</th>
                <th className="p-3">Symbol & Setup</th>
                <th className="p-3">Regime</th>
                <th className="p-3">Vector (ADX/RSI/Vol)</th>
                <th className="p-3">Meta Conf</th>
                <th className="p-3">Outcome & PnL</th>
                <th className="p-3">Post-Classification</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 font-mono">
              {filtered.slice(0, 50).map((exp) => (
                <tr key={exp.id} className="hover:bg-stone-50/80">
                  <td className="p-3 text-stone-500">
                    <span className="font-bold text-stone-700 block">{exp.id}</span>
                    <span className="text-[10px]">{exp.timestamp.slice(0, 10)}</span>
                  </td>
                  <td className="p-3">
                    <span className="font-bold text-stone-800">{exp.symbol}</span>
                    <span className="block text-[10px] text-stone-500 font-sans">{exp.setupName}</span>
                  </td>
                  <td className="p-3">
                    <span className="px-2 py-0.5 rounded bg-stone-100 text-stone-700 text-[10px] capitalize">
                      {exp.regime.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="p-3 text-stone-600 text-[11px]">
                    ADX {exp.features.adx} • RSI {exp.features.rsi} • Vol {exp.features.volumeSurgeRatio}x
                  </td>
                  <td className="p-3">
                    <span className="font-bold text-indigo-700">
                      {Math.round(exp.metaConfidence * 100)}%
                    </span>
                  </td>
                  <td className="p-3">
                    <span
                      className={`font-bold ${
                        exp.outcome === "WIN" ? "text-emerald-600" : "text-rose-600"
                      }`}
                    >
                      {exp.outcome} (₹{exp.pnl})
                    </span>
                  </td>
                  <td className="p-3">
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded font-sans font-medium ${
                        exp.postClassification === "good_decision_good_outcome"
                          ? "bg-emerald-100 text-emerald-800"
                          : exp.postClassification === "good_decision_bad_outcome"
                          ? "bg-amber-100 text-amber-800"
                          : exp.postClassification === "bad_decision_good_outcome"
                          ? "bg-indigo-100 text-indigo-800"
                          : "bg-rose-100 text-rose-800"
                      }`}
                    >
                      {exp.postClassification?.replace(/_/g, " ")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
