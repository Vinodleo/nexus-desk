import React, { useState } from "react";
import { TradeProposal } from "../types";
import {
  Check,
  X,
  ShieldAlert,
  Sparkles,
  Radar,
  TrendingUp,
  BrainCircuit,
  Award,
  Zap,
} from "lucide-react";

interface QueueTabProps {
  proposals: TradeProposal[];
  onApproveProposal: (proposal: TradeProposal) => void;
  onRejectProposal: (proposalId: string, reason: string) => void;
  onApproveAllProposals?: () => void;
  onTriggerScanner?: () => void;
  isScanning?: boolean;
  isContinuousScanActive?: boolean;
  onToggleContinuousScan?: () => void;
  isSelfApproveActive?: boolean;
  onToggleSelfApprove?: () => void;
  memoryVectorCount?: number;
  activePositionsCount?: number;
  onSwitchToBook?: () => void;
}

export const QueueTab: React.FC<QueueTabProps> = ({
  
  proposals,
  onApproveProposal,
  onRejectProposal,
  onApproveAllProposals,
  onTriggerScanner,
  isScanning = false,
  isContinuousScanActive = true,
  onToggleContinuousScan,
  isSelfApproveActive = false,
  onToggleSelfApprove,
  memoryVectorCount = 420,
  activePositionsCount = 0,
  onSwitchToBook,
}) => {
  const [approvingIds, setApprovingIds] = useState<string[]>([]);

  const handleApprove = (proposal: TradeProposal) => {
    setApprovingIds(prev => [...prev, proposal.id]);
    setTimeout(() => {
      onApproveProposal(proposal);
      setApprovingIds(prev => prev.filter(id => id !== proposal.id));
    }, 400);
  };

  // Sort pending proposals strictly by Calibrated Win Probability P(Win) descending,
  // so the one with the highest probability of winning is ranked #1 and appears at the top.
  const pending = proposals
    .filter((p) => p.status === "PENDING_APPROVAL" || p.status === "DEFERRED")
    .sort(
      (a, b) =>
        b.metaScore.calibratedWinProbability -
          a.metaScore.calibratedWinProbability ||
        b.evAssessment.expectedNetValue - a.evAssessment.expectedNetValue
    );

  const recentlyApproved = proposals
    .filter((p) => p.status === "APPROVED")
    .slice(0, 5);

  return (
    <div className="space-y-4 pb-20 select-none">
      {/* Professional Agent Header with Continuous Scanner Status */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-sans font-semibold text-stone-100">
            Needs approval
          </h2>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#181822] text-stone-300 border border-[#2b2b38]">
            Ranked by P(Win)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {onToggleSelfApprove && (
            <button
              onClick={onToggleSelfApprove}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono tracking-wider transition-all cursor-pointer border ${
                isSelfApproveActive
                  ? "bg-emerald-950 text-emerald-300 border-emerald-600 font-bold"
                  : "bg-[#16161c] text-stone-400 border-stone-800"
              }`}
              title="When enabled, agents self-approve candidates with P(Win) >= 52%"
            >
              <Zap
                className={`w-3 h-3 ${
                  isSelfApproveActive ? "text-emerald-400 fill-emerald-400" : "text-stone-500"
                }`}
              />
              <span>
                {isSelfApproveActive ? "SELF-APPROVE: ON" : "SELF-APPROVE: OFF"}
              </span>
            </button>
          )}

          {onToggleContinuousScan && (
            <button
              onClick={onToggleContinuousScan}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono tracking-wider transition-all cursor-pointer border ${
                isContinuousScanActive
                  ? "bg-emerald-950/70 text-emerald-300 border-emerald-800/60"
                  : "bg-[#16161c] text-stone-400 border-stone-800"
              }`}
              title="Continuous scanning automatically evaluates 14 universe instruments every cycle"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isContinuousScanActive
                    ? "bg-emerald-400 animate-pulse"
                    : "bg-stone-500"
                }`}
              />
              <span>
                {isContinuousScanActive ? "RADAR: ON" : "RADAR: PAUSED"}
              </span>
            </button>
          )}

          <span className="text-xs font-mono tracking-wider text-stone-400 font-medium">
            {pending.length} OPEN
          </span>
        </div>
      </div>

      {/* Continuous Scanning Active Notification Banner */}
      <div className="rounded-xl bg-[#0d0d12] border border-[#20202a] px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs font-mono text-stone-300">
        <div className="flex items-center gap-2.5">
          <div className="relative flex items-center justify-center">
            <Radar
              className={`w-4 h-4 ${
                isContinuousScanActive
                  ? "text-emerald-400 animate-spin"
                  : "text-stone-500"
              }`}
              style={{ animationDuration: "6s" }}
            />
            {isContinuousScanActive && (
              <span className="absolute w-2 h-2 rounded-full bg-emerald-400/30 animate-ping" />
            )}
          </div>
          <div>
            <span className="text-stone-200 font-medium">
              Continuous Market Scanner
            </span>
            <span className="text-stone-400 text-[11px] block sm:inline sm:ml-2">
              18 multi-asset markets (Indices, Equities, Gold, Oil, FX, Crypto) · Meta learning active
            </span>
          </div>
        </div>

        <button
          onClick={onTriggerScanner}
          disabled={isScanning}
          className="px-2.5 py-1 rounded-lg bg-[#181822] hover:bg-[#222230] border border-[#2c2c3a] text-[11px] text-stone-300 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
        >
          {isScanning ? (
            <>
              <span className="animate-spin text-stone-400">◌</span>
              <span>Scanning...</span>
            </>
          ) : (
            <>
              <Zap className="w-3 h-3 text-amber-400" />
              <span>Scan Now</span>
            </>
          )}
        </button>
      </div>

      {/* Self-Approval Active Status Banner */}
      {isSelfApproveActive && (
        <div className="rounded-xl bg-emerald-950/40 border border-emerald-500/40 px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs font-mono text-emerald-200">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-emerald-400 fill-emerald-400 animate-pulse" />
            <div>
              <span className="font-bold text-emerald-300">
                SELF-APPROVE IS ON:
              </span>
              <span className="text-emerald-400/80 ml-1.5 text-[11px]">
                {pending.length > 0
                  ? `All ${pending.length} trade${pending.length > 1 ? "s" : ""} in queue are automatically auto-approved into the Book`
                  : "All incoming radar trades are automatically approved and executed directly into the Book"}
              </span>
            </div>
          </div>

          {pending.length > 0 && onApproveAllProposals && (
            <button
              onClick={onApproveAllProposals}
              className="px-3 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-[11px] font-bold font-mono tracking-wider transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap shadow-sm"
            >
              <Zap className="w-3 h-3 text-emerald-950 fill-emerald-950" />
              <span>Auto-Approve All ({pending.length})</span>
            </button>
          )}
        </div>
      )}

      {/* When Empty (Screenshot 3) */}
      {pending.length === 0 ? (
        <div className="rounded-2xl bg-[#0e0e11] border border-[#202026] p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-stone-300">
              <BrainCircuit
                className={`w-4 h-4 ${
                  isSelfApproveActive ? "text-emerald-400" : "text-stone-400"
                }`}
              />
              <h3 className="text-base font-sans font-medium text-stone-200">
                {isSelfApproveActive
                  ? "Self-Approve is active — All trades auto-executed into Book"
                  : "Commander is watching live markets."}
              </h3>
            </div>

            {onSwitchToBook && (
              <button
                onClick={onSwitchToBook}
                className="text-[11px] font-mono text-emerald-400 hover:text-emerald-300 flex items-center gap-1 cursor-pointer transition-colors"
              >
                <span>View Book ({activePositionsCount})</span>
                <span>→</span>
              </button>
            )}
          </div>

          <p className="text-xs text-stone-400 leading-relaxed font-sans">
            {isSelfApproveActive
              ? "Because Self-Approve is enabled, all eligible setups in the queue are immediately auto-approved and opened in your live execution book without requiring manual confirmation. New market opportunities detected by the continuous radar scan will automatically execute."
              : "Specialist agents continuously evaluate incoming 5m bars. Only setups with high win probability (P(Win) ≥ 0.52 hurdle) and positive net expectancy after friction are admitted to this queue. Losing patterns logged in experience memory are automatically filtered out."}
          </p>

          {/* If there are recently approved trades, show them */}
          {recentlyApproved.length > 0 && (
            <div className="pt-2 border-t border-[#1c1c24] space-y-2">
              <div className="text-[11px] font-mono text-stone-400 uppercase tracking-wider flex items-center justify-between">
                <span>Recently Auto-Approved into Book</span>
                <span className="text-emerald-400 font-bold">
                  {recentlyApproved.length} FILLED
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {recentlyApproved.map((p) => (
                  <div
                    key={p.id}
                    className="p-2.5 rounded-xl bg-[#14141b] border border-[#232330] flex items-center justify-between text-xs font-mono"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          p.setup.direction === "LONG"
                            ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                            : "bg-rose-950 text-rose-300 border border-rose-800"
                        }`}
                      >
                        {p.setup.direction}
                      </span>
                      <span className="font-bold text-stone-200">
                        {p.symbol}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-emerald-400 font-bold block">
                        {Math.round(p.metaScore.calibratedWinProbability * 100)}%
                        P(Win)
                      </span>
                      <span className="text-[10px] text-stone-500">
                        @ ₹{p.setup.entryPrice.toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="pt-2 flex items-center justify-between border-t border-[#1c1c24] text-[11px] font-mono text-stone-400">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Memory Bank: {memoryVectorCount} historical vectors
            </span>
            <span className="text-stone-500">Core strategy rules frozen</span>
          </div>
        </div>
      ) : (
        /* Active Proposals List - Ranked by Highest Probability of Winning */
        <div className="space-y-3">
          {pending.map((proposal, index) => {
            const isRankOne = index === 0;
            const winProbPercent = Math.round(
              proposal.metaScore.calibratedWinProbability * 100
            );
            const sizeDollars =
              proposal.riskCalc.recommendedDollarExposure || 8000;
            const stopPct = (
              ((proposal.setup.stopLoss - proposal.setup.entryPrice) /
                proposal.setup.entryPrice) *
              100
            ).toFixed(2);
            const targetPct = (
              ((proposal.setup.takeProfit - proposal.setup.entryPrice) /
                proposal.setup.entryPrice) *
              100
            ).toFixed(2);
            const isLong = proposal.setup.direction === "LONG";

            return (
              <div
                key={proposal.id}
                className={`rounded-2xl p-5 space-y-4 shadow-xl transition-all ${
                  isRankOne
                    ? "bg-[#0e0e13] border-2 border-emerald-500/40 ring-1 ring-emerald-500/20"
                    : "bg-[#0e0e11] border border-[#24242d]"
                }`}
              >
                {/* Ranking Badge & Win Probability Header */}
                <div className="flex items-center justify-between pb-1">
                  <div className="flex items-center gap-2">
                    {isRankOne ? (
                      <span className="px-2.5 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[10px] font-mono tracking-wider font-semibold flex items-center gap-1">
                        <Award className="w-3 h-3 text-emerald-400" />
                        <span>RANK #1 · HIGHEST P(WIN)</span>
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-[#1c1c24] text-stone-400 text-[10px] font-mono tracking-wider">
                        RANK #{index + 1}
                      </span>
                    )}

                    <span
                      className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
                        winProbPercent >= 55
                          ? "bg-emerald-950 text-emerald-300 border border-emerald-800/60"
                          : "bg-stone-800 text-stone-300"
                      }`}
                    >
                      {winProbPercent}% P(Win)
                    </span>
                  </div>

                  <span className="text-[10px] font-mono text-stone-500">
                    Hurdle: 52% | Samples: {proposal.metaScore.historicalSampleCount || 0}
                  </span>
                </div>

                {/* Professional Rationale summary */}
                <div className="text-xs font-sans text-stone-300 leading-relaxed">
                  <span className="font-semibold text-white">
                    {proposal.symbol} {proposal.setup.direction}
                  </span>
                  : High volume surge ({proposal.setup.features.volumeSurgeRatio}x).{" "}
                  {proposal.regime.replace(/_/g, " ")} regime. Memory bank confirms edge.{" "}
                  EV {proposal.evAssessment.expectedNetValue >= 0 ? "+" : ""}
                  {(proposal.evAssessment.expectedNetValue / 100).toFixed(2)}R
                  net after 14 bps round-trip friction.
                </div>

                {/* Key Execution Numbers: SIZE, STOP, TARGET */}
                <div className="grid grid-cols-3 gap-2 py-2 border-y border-[#1c1c24]">
                  <div>
                    <div className="text-[10px] font-mono tracking-wider text-stone-500 uppercase">
                      Size
                    </div>
                    <div className="text-sm font-mono font-medium text-stone-100 mt-0.5">
                      ₹{Math.round(sizeDollars).toLocaleString()}
                    </div>
                    <div className="text-[10px] font-mono text-stone-500">
                      {proposal.riskCalc.recommendedPositionSizeUnits} units
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] font-mono tracking-wider text-stone-500 uppercase">
                      Stop
                    </div>
                    <div className="text-sm font-mono font-medium text-rose-400 mt-0.5">
                      {Number(stopPct) > 0 ? `-${stopPct}` : stopPct}%
                    </div>
                    <div className="text-[10px] font-mono text-stone-500">
                      ₹{proposal.setup.stopLoss.toFixed(2)}
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] font-mono tracking-wider text-stone-500 uppercase">
                      Target
                    </div>
                    <div className="text-sm font-mono font-medium text-emerald-400 mt-0.5">
                      {Number(targetPct) < 0
                        ? `+${Math.abs(Number(targetPct)).toFixed(2)}`
                        : `+${targetPct}`}
                      %
                    </div>
                    <div className="text-[10px] font-mono text-stone-500">
                      ₹{proposal.setup.takeProfit.toFixed(2)}
                    </div>
                  </div>
                </div>

                {/* Detailed Quantitative Metadata Grid */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-stone-500 uppercase text-[10px]">
                      Instrument
                    </span>
                    <span className="text-stone-200 font-medium">
                      {proposal.symbol}
                    </span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-stone-500 uppercase text-[10px]">
                      Setup
                    </span>
                    <span className="text-stone-200 truncate max-w-[100px]">
                      {proposal.setup.name}
                    </span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-stone-500 uppercase text-[10px]">
                      Regime
                    </span>
                    <span className="text-stone-300">
                      {proposal.regime.split("_")[0]}
                    </span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-stone-500 uppercase text-[10px]">
                      Memory Match
                    </span>
                    <span className="text-stone-300">
                      {proposal.metaScore.historicalSampleCount || 0} vectors
                    </span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-stone-500 uppercase text-[10px]">
                      Meta Hurdle
                    </span>
                    <span className="text-emerald-400 font-medium">
                      PASS (≥ 0.52)
                    </span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-stone-500 uppercase text-[10px]">
                      P(Win)
                    </span>
                    <span className="text-emerald-400 font-bold">
                      {winProbPercent}%
                    </span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-stone-500 uppercase text-[10px]">
                      EV After Costs
                    </span>
                    <span className="text-emerald-400 font-medium">
                      +{(proposal.evAssessment.expectedNetValue / 100).toFixed(2)}R
                    </span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-stone-500 uppercase text-[10px]">
                      Costs
                    </span>
                    <span className="text-stone-400">14 bps round-trip</span>
                  </div>
                </div>

                {/* Professional Action Buttons: Veto/Skip & Approve Ticket */}
                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={() =>
                      onRejectProposal(
                        proposal.id,
                        "Supervisor veto: discretionary risk adjustment"
                      )
                    }
                    className="flex-1 py-2.5 rounded-xl bg-[#191920] hover:bg-[#22222a] border border-[#2b2b36] text-stone-300 text-xs font-mono tracking-wider transition-all cursor-pointer text-center"
                  >
                    Veto / Skip
                  </button>

                  <button
                    onClick={() => handleApprove(proposal)}
                    className={`flex-1 py-2.5 rounded-xl font-semibold text-xs font-mono tracking-wider shadow-sm transition-all cursor-pointer flex items-center justify-center gap-2 ${approvingIds.includes(proposal.id) ? "scale-95 opacity-80" : "scale-100 hover:-translate-y-0.5"} ${
                      isRankOne
                        ? "bg-emerald-400 hover:bg-emerald-300 text-emerald-950 font-bold"
                        : "bg-stone-100 hover:bg-white text-stone-900"
                    }`}
                  >
                    {approvingIds.includes(proposal.id) ? (
                      <>
                        <Zap className="w-3.5 h-3.5 animate-bounce" />
                        Executing...
                      </>
                    ) : (
                      isRankOne ? "Approve #1 Ticket" : "Approve Ticket"
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
