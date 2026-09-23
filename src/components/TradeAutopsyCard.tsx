import React, { useState } from "react";
import { HistoricalTrade, TradeAutopsy } from "../types";
import { BrainCircuit, CheckCircle2, Loader2, Target, AlertTriangle, TrendingUp, TrendingDown, RefreshCcw } from "lucide-react";
import { apiFetch } from "../services/apiClient";

interface TradeAutopsyCardProps {
  trade: HistoricalTrade;
  onUpdateTrade?: (trade: HistoricalTrade) => void;
}

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
      
      const newTrade = {
        ...trade,
        autopsy: result.autopsy || result
      };

      if (onUpdateTrade) {
        onUpdateTrade(newTrade);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to generate autopsy");
    } finally {
      setIsGenerating(false);
    }
  };

  if (!trade.autopsy) {
    return (
      <div className="mt-3 pt-3 border-t border-[#22222a]">
        <button
          onClick={handleGenerateAutopsy}
          disabled={isGenerating}
          className="flex items-center gap-2 text-xs font-mono px-3 py-1.5 rounded-lg bg-[#14141d] border border-[#2c2c36] text-stone-300 hover:text-emerald-300 hover:border-emerald-900/50 hover:bg-[#15201d] transition-all disabled:opacity-50"
        >
          {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BrainCircuit className="w-3.5 h-3.5" />}
          {isGenerating ? "Analyzing Trade Patterns..." : "Generate AI Post-Mortem"}
        </button>
        {error && <div className="text-rose-400 text-[10px] mt-1 ml-1">{error}</div>}
      </div>
    );
  }

  const { autopsy } = trade;
  
  const isGoodDecision = autopsy.classification.startsWith("good_decision");
  const isGoodOutcome = autopsy.classification.endsWith("good_outcome");

  return (
    <div className="mt-3 pt-3 border-t border-[#22222a]">
      <div className="bg-[#121217] rounded-xl border border-[#25252e] overflow-hidden">
        <div className="flex items-center justify-between p-2.5 bg-[#181820] border-b border-[#25252e]">
          <div className="flex items-center gap-2 text-stone-200 text-xs font-mono font-medium">
            <BrainCircuit className="w-3.5 h-3.5 text-blue-400" />
            AI Trade Autopsy
          </div>
          <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono uppercase font-semibold ${
            isGoodDecision 
              ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-800/50' 
              : 'bg-amber-950/50 text-amber-300 border border-amber-800/50'
          }`}>
            {isGoodDecision ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
            {isGoodDecision ? "Sound Process" : "Flawed Process"}
          </div>
        </div>
        
        <div className="p-3 space-y-3">
          <p className="text-xs font-sans text-stone-300 leading-relaxed italic">
            "{autopsy.autopsySummary}"
          </p>
          
          <div className="space-y-2">
            <div>
              <span className="text-[10px] font-mono text-stone-500 uppercase">Root Cause Analysis</span>
              <p className="text-xs font-sans text-stone-300 mt-0.5">{autopsy.rootCause}</p>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              <div>
                <span className="text-[10px] font-mono text-stone-500 uppercase">Learning Tags</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {autopsy.learningTags.map((tag, idx) => (
                    <span key={idx} className="px-1.5 py-0.5 rounded-sm bg-[#1e1e26] text-stone-400 text-[9px] font-mono">
                      #{tag}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-[10px] font-mono text-stone-500 uppercase">Condition Adjustments</span>
                <div className="flex items-center gap-1.5 mt-1 text-xs font-mono">
                  <RefreshCcw className="w-3.5 h-3.5 text-blue-400" />
                  <span className={autopsy.metaModelCalibrationDelta > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {autopsy.metaModelCalibrationDelta > 0 ? '+' : ''}{(autopsy.metaModelCalibrationDelta * 100).toFixed(1)}% Confidence Delta
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
