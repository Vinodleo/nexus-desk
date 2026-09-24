import React, { useState } from "react";
import { HistoricalTrade } from "../types";
import { Sparkles, CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import { apiFetch } from "../services/apiClient";

interface TradeAutopsyCardProps {
  trade: HistoricalTrade;
  onUpdateTrade?: (trade: HistoricalTrade) => void;
}

// AI post-mortem for a closed trade: generated on request by the server's
// Gemini agent, then stored on the trade.
export const TradeAutopsyCard: React.FC<TradeAutopsyCardProps> = ({ trade, onUpdateTrade }) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerateAutopsy = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const response = await apiFetch("/api/agent/trade-autopsy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trade }),
      });

      if (!response.ok) {
        throw new Error("Failed to generate autopsy");
      }

      const result = await response.json();
      onUpdateTrade?.({ ...trade, autopsy: result.autopsy || result });
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to generate autopsy");
    } finally {
      setIsGenerating(false);
    }
  };

  if (!trade.autopsy) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={handleGenerateAutopsy}
          disabled={isGenerating}
          className="self-start min-h-10 px-4 rounded-full border border-line bg-surface text-[13px] font-semibold flex items-center gap-2 cursor-pointer disabled:opacity-60"
        >
          {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-accent" />}
          {isGenerating ? "Reviewing the trade…" : "Explain this trade"}
        </button>
        {error && <div className="text-xs text-loss">{error}</div>}
      </div>
    );
  }

  const { autopsy } = trade;
  const isGoodDecision = autopsy.classification.startsWith("good_decision");
  const delta = autopsy.metaModelCalibrationDelta;

  return (
    <div className="rounded-xl bg-inset p-3.5 flex flex-col gap-2.5 text-[13px] leading-relaxed">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 font-semibold">
          <Sparkles className="w-4 h-4 text-accent" />
          Autopsy
        </span>
        <span className={`flex items-center gap-1 text-xs font-semibold ${isGoodDecision ? "text-gain" : "text-warn"}`}>
          {isGoodDecision ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
          {isGoodDecision ? "Sound decision" : "Flawed decision"}
        </span>
      </div>
      <p className="m-0">{autopsy.autopsySummary}</p>
      <div>
        <div className="text-xs text-muted">Root cause</div>
        <p className="m-0">{autopsy.rootCause}</p>
      </div>
      {autopsy.learningTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {autopsy.learningTags.map((tag, idx) => (
            <span key={idx} className="px-2 py-0.5 rounded-full bg-surface border border-line text-xs text-muted">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="text-xs text-muted">
        Confidence adjustment for similar setups:{" "}
        <span className={`font-semibold ${delta > 0 ? "text-gain" : delta < 0 ? "text-loss" : ""}`}>
          {delta > 0 ? "+" : ""}
          {(delta * 100).toFixed(1)}%
        </span>
      </div>
    </div>
  );
};
