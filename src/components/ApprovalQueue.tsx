import React, { useState, useEffect } from "react";
import {
  ShieldCheck,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Play,
  TrendingUp,
  TrendingDown,
  Layers,
  Sparkles,
  ArrowRight,
  Filter,
  DollarSign,
  Activity,
  Sliders,
  Check,
  RefreshCw,
  Eye,
} from "lucide-react";
import { TradeProposal } from "../types";

interface ApprovalQueueProps {
  proposals: TradeProposal[];
  onApproveProposal: (proposal: TradeProposal) => void;
  onRejectProposal: (proposal: TradeProposal) => void;
  onInspectProposal: (proposal: TradeProposal) => void;
  onOpenModal: (proposal: TradeProposal) => void;
  onScanAllMarkets: () => void;
  onClearInactive: () => void;
  onBatchApprove: () => void;
  isScanning: boolean;
  autoScanEnabled: boolean;
  onToggleAutoScan: () => void;
  lastScanTime: string | null;
}

export const ApprovalQueue: React.FC<ApprovalQueueProps> = ({
  proposals,
  onApproveProposal,
  onRejectProposal,
  onInspectProposal,
  onOpenModal,
  onScanAllMarkets,
  onClearInactive,
  onBatchApprove,
  isScanning,
  autoScanEnabled,
  onToggleAutoScan,
  lastScanTime,
}) => {
  const [filterTab, setFilterTab] = useState<"pending" | "approved" | "all">("pending");
  const [now, setNow] = useState<number>(Date.now());

  // Update clock every second for live countdown display
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const pendingProposals = proposals.filter((p) => p.status === "PENDING_APPROVAL");
  const approvedProposals = proposals.filter(
    (p) => p.status === "APPROVED" || p.status === "AUTO_EXECUTED"
  );
  const inactiveCount = proposals.filter(
    (p) => p.status === "EXPIRED" || p.status === "REJECTED"
  ).length;

  const filteredProposals = proposals.filter((p) => {
    if (filterTab === "pending") return p.status === "PENDING_APPROVAL";
    if (filterTab === "approved") return p.status === "APPROVED" || p.status === "AUTO_EXECUTED";
    return true;
  });

  return (
    <div id="agent-approval-queue" className="bg-white border border-stone-200 rounded-xl shadow-xs overflow-hidden">
      {/* Header & Controls Bar */}
      <div className="p-4 sm:p-5 border-b border-stone-200 bg-stone-50/60 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-100 border border-emerald-300 flex items-center justify-center text-emerald-800">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-sm text-stone-900">
                Agent Market Scanner & Approval Queue
              </h3>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                Section 9 Policy
              </span>
            </div>
            <p className="text-xs text-stone-500">
              Agents continuously scan markets, evaluate setups, verify risk & Kelly sizing, then queue proposals for authorization.
            </p>
          </div>
        </div>

        {/* Scanner Actions */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Auto-Scan Switch */}
          <button
            id="toggle-auto-scan-btn"
            onClick={onToggleAutoScan}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer transition-colors ${
              autoScanEnabled
                ? "bg-emerald-50 border-emerald-300 text-emerald-800 shadow-xs"
                : "bg-white border-stone-200 text-stone-600 hover:bg-stone-100"
            }`}
            title="Automatically scan all markets every 30 seconds"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                autoScanEnabled ? "bg-emerald-500 animate-pulse" : "bg-stone-300"
              }`}
            />
            <span>Auto-Scan {autoScanEnabled ? "ON (30s)" : "OFF"}</span>
          </button>

          {/* Trigger Scan All Markets */}
          <button
            id="scan-all-markets-btn"
            onClick={onScanAllMarkets}
            disabled={isScanning}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-stone-900 hover:bg-stone-800 text-white font-medium text-xs shadow-xs transition-colors cursor-pointer disabled:opacity-50"
          >
            <Sparkles className={`w-3.5 h-3.5 text-amber-400 ${isScanning ? "animate-spin" : ""}`} />
            <span>{isScanning ? "Scanning Markets..." : "Scan All Markets"}</span>
          </button>

          {/* Batch Approve button if pending proposals exist */}
          {pendingProposals.length > 1 && (
            <button
              id="batch-approve-all-btn"
              onClick={onBatchApprove}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs shadow-xs transition-colors cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Approve All ({pendingProposals.length})</span>
            </button>
          )}

          {/* Clear Inactive/Expired */}
          {inactiveCount > 0 && (
            <button
              id="clear-inactive-proposals-btn"
              onClick={onClearInactive}
              className="text-stone-500 hover:text-stone-700 text-xs px-2 py-1 underline cursor-pointer"
            >
              Clear Expired ({inactiveCount})
            </button>
          )}
        </div>
      </div>

      {/* Live Scanning Status Banner */}
      {isScanning && (
        <div className="bg-emerald-50 border-b border-emerald-200 px-4 py-2.5 flex items-center justify-between text-xs text-emerald-900 font-mono animate-pulse">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-600 animate-spin" />
            <span>
              Multi-Agent Scanner active: Scanning NIFTY 50, BTC/INR, SPY, ETH/INR... Computing indicators, meta-labeling, EV & Kelly risk bounds...
            </span>
          </div>
          <span className="text-[11px] font-sans text-emerald-700 font-semibold">Live Analysis</span>
        </div>
      )}

      {/* Tabs & Filter Bar */}
      <div className="px-4 sm:px-5 py-2.5 border-b border-stone-200 bg-stone-50/30 flex items-center justify-between text-xs">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setFilterTab("pending")}
            className={`px-3 py-1.5 rounded-md font-semibold cursor-pointer transition-colors flex items-center gap-1.5 ${
              filterTab === "pending"
                ? "bg-stone-900 text-white shadow-xs"
                : "text-stone-600 hover:bg-stone-200"
            }`}
          >
            <span>Pending Approvals</span>
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                filterTab === "pending"
                  ? "bg-amber-400 text-stone-900"
                  : "bg-stone-200 text-stone-700"
              }`}
            >
              {pendingProposals.length}
            </span>
          </button>

          <button
            onClick={() => setFilterTab("approved")}
            className={`px-3 py-1.5 rounded-md font-semibold cursor-pointer transition-colors flex items-center gap-1.5 ${
              filterTab === "approved"
                ? "bg-stone-900 text-white shadow-xs"
                : "text-stone-600 hover:bg-stone-200"
            }`}
          >
            <span>Approved / Executed</span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-stone-200 text-stone-700">
              {approvedProposals.length}
            </span>
          </button>

          <button
            onClick={() => setFilterTab("all")}
            className={`px-3 py-1.5 rounded-md font-semibold cursor-pointer transition-colors flex items-center gap-1.5 ${
              filterTab === "all"
                ? "bg-stone-900 text-white shadow-xs"
                : "text-stone-600 hover:bg-stone-200"
            }`}
          >
            <span>All Proposals</span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-stone-200 text-stone-700">
              {proposals.length}
            </span>
          </button>
        </div>

        {lastScanTime && (
          <span className="text-[11px] text-stone-400 font-mono hidden md:inline">
            Last scan: {lastScanTime}
          </span>
        )}
      </div>

      {/* Proposals List */}
      <div className="p-4 sm:p-5 space-y-4">
        {filteredProposals.length === 0 ? (
          <div className="py-12 text-center text-stone-400 text-xs font-mono space-y-3">
            <ShieldCheck className="w-8 h-8 mx-auto text-stone-300" />
            <p className="text-stone-600 font-sans font-medium text-sm">
              {filterTab === "pending"
                ? "No pending proposals awaiting approval."
                : filterTab === "approved"
                ? "No approved proposals logged yet."
                : "Queue is empty."}
            </p>
            <p className="text-stone-400 max-w-md mx-auto text-[11px]">
              Click <strong>"Scan All Markets"</strong> to have the Market Analysis, Strategy, and Supervisor Agents scan for qualified setups and stage them here.
            </p>
            <button
              onClick={onScanAllMarkets}
              disabled={isScanning}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs shadow-xs transition-colors cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-300" />
              <span>Run Market Scan Now</span>
            </button>
          </div>
        ) : (
          filteredProposals.map((proposal) => {
            const isLong = proposal.setup.direction === "LONG";
            const expiresAt = proposal.expiresAt || Date.now() + 45000;
            const remainingSec = Math.max(0, Math.ceil((expiresAt - now) / 1000));
            const isPending = proposal.status === "PENDING_APPROVAL";
            const isApproved =
              proposal.status === "APPROVED" || proposal.status === "AUTO_EXECUTED";
            const isExpired = proposal.status === "EXPIRED";
            const isRejected = proposal.status === "REJECTED";

            const rrRatio =
              Math.abs(proposal.setup.takeProfit - proposal.setup.entryPrice) /
              Math.max(0.01, Math.abs(proposal.setup.entryPrice - proposal.setup.stopLoss));

            return (
              <div
                key={proposal.id}
                id={`proposal-card-${proposal.id}`}
                className={`rounded-xl border p-4 transition-all ${
                  isPending
                    ? "bg-white border-amber-300 shadow-sm ring-1 ring-amber-100"
                    : isApproved
                    ? "bg-emerald-50/40 border-emerald-200"
                    : "bg-stone-50 border-stone-200 opacity-80"
                }`}
              >
                {/* Proposal Top Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-stone-200">
                  <div className="flex items-center gap-2.5">
                    {/* Symbol badge */}
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sm text-stone-900 tracking-tight">
                        {proposal.symbol}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded font-bold text-[10px] tracking-wider ${
                          isLong
                            ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                            : "bg-rose-100 text-rose-800 border border-rose-200"
                        }`}
                      >
                        {proposal.setup.direction}
                      </span>
                    </div>

                    {/* Setup Name */}
                    <span className="text-xs font-semibold text-stone-700">
                      {proposal.setup.name}
                    </span>

                    {/* Regime Tag */}
                    <span className="hidden sm:inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-stone-100 border border-stone-200 text-stone-600 capitalize">
                      {proposal.regime.replace(/_/g, " ")}
                    </span>
                  </div>

                  {/* Status / Countdown */}
                  <div className="flex items-center gap-2">
                    {isPending && (
                      <div
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded font-mono text-xs border ${
                          remainingSec > 20
                            ? "bg-amber-50 border-amber-200 text-amber-800"
                            : remainingSec > 0
                            ? "bg-rose-50 border-rose-200 text-rose-700 animate-pulse font-bold"
                            : "bg-stone-100 border-stone-300 text-stone-600"
                        }`}
                      >
                        <Clock className="w-3.5 h-3.5" />
                        <span>
                          {remainingSec > 0
                            ? `${remainingSec}s to Auto-Expire`
                            : "Expiring (Fail-Closed)..."}
                        </span>
                      </div>
                    )}

                    {isApproved && (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 border border-emerald-300 text-emerald-800 font-semibold text-xs">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{proposal.status === "AUTO_EXECUTED" ? "Auto-Executed" : "Approved"}</span>
                      </span>
                    )}

                    {isExpired && (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 border border-amber-300 text-amber-800 font-semibold text-xs">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span>Expired (Fail-Closed)</span>
                      </span>
                    )}

                    {isRejected && (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-rose-100 border border-rose-300 text-rose-800 font-semibold text-xs">
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Rejected</span>
                      </span>
                    )}

                    <span className="text-[10px] font-mono text-stone-400">
                      ID: {proposal.id}
                    </span>
                  </div>
                </div>

                {/* Expiry Progress Bar if Pending */}
                {isPending && (
                  <div className="w-full bg-stone-100 h-1.5 rounded-full overflow-hidden my-2.5">
                    <div
                      className={`h-full transition-all duration-1000 ${
                        remainingSec > 25
                          ? "bg-emerald-500"
                          : remainingSec > 10
                          ? "bg-amber-500"
                          : "bg-rose-500"
                      }`}
                      style={{
                        width: `${Math.min(100, (remainingSec / (proposal.approvalExpiryMs / 1000 || 60)) * 100)}%`,
                      }}
                    />
                  </div>
                )}

                {/* Grid: Order Parameters & Quantitative Edge */}
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2.5 my-3 p-3 bg-stone-50 rounded-lg border border-stone-200 text-xs font-mono">
                  <div>
                    <div className="text-[10px] text-stone-500 font-sans">Limit Entry</div>
                    <div className="font-bold text-stone-900">₹{proposal.setup.entryPrice.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-stone-500 font-sans">Stop Loss</div>
                    <div className="font-bold text-rose-600">₹{proposal.setup.stopLoss.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-stone-500 font-sans">Take Profit</div>
                    <div className="font-bold text-emerald-600">₹{proposal.setup.takeProfit.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-stone-500 font-sans">Risk / Reward</div>
                    <div className="font-bold text-stone-800">1 : {rrRatio.toFixed(1)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-stone-500 font-sans">Position Size</div>
                    <div className="font-bold text-stone-900">
                      {proposal.riskCalc.recommendedPositionSizeUnits} units
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-stone-500 font-sans">Dollar Risk</div>
                    <div className="font-bold text-amber-700">₹{proposal.riskCalc.riskDollars.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-stone-500 font-sans">Net EV Edge</div>
                    <div className="font-bold text-emerald-700">
                      +₹{proposal.evAssessment.expectedNetValue.toFixed(2)}
                    </div>
                  </div>
                </div>

                {/* Agent Analysis & Rationale */}
                <div className="space-y-1.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-stone-800 flex items-center gap-1">
                      <Sparkles className="w-3 h-3 text-amber-500" />
                      Agent Synthesis:
                    </span>
                    <span className="px-1.5 py-0.2 rounded bg-stone-100 text-stone-700 font-mono text-[10px]">
                      Meta-Confidence: <strong>{(proposal.metaScore.confidence * 100).toFixed(0)}%</strong>
                    </span>
                    <span className="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 font-mono text-[10px] font-bold">
                      {proposal.aiRecommendation || "TRADE_FAVORED"}
                    </span>
                    {proposal.approvalToken && (
                      <span className="text-[10px] font-mono text-stone-400">
                        Token: {proposal.approvalToken}
                      </span>
                    )}
                  </div>
                  <p className="text-stone-700 leading-relaxed text-[11px] bg-stone-50/80 p-2.5 rounded-lg border border-stone-200">
                    {proposal.supervisorNotes}
                  </p>
                  {proposal.failureConditionRisk && (
                    <div className="flex items-start gap-1.5 text-[11px] text-amber-800">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600" />
                      <span>
                        <strong>Failure Condition Trap:</strong> {proposal.failureConditionRisk}
                      </span>
                    </div>
                  )}
                </div>

                {/* Action Controls for Pending Proposals */}
                {isPending && (
                  <div className="mt-4 pt-3 border-t border-stone-200 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onInspectProposal(proposal)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-300 bg-white hover:bg-stone-50 text-stone-700 text-xs font-medium cursor-pointer transition-colors"
                        title="View all 9 decision pipeline steps for this setup"
                      >
                        <Eye className="w-3.5 h-3.5 text-stone-500" />
                        <span>Inspect in Pipeline</span>
                      </button>

                      <button
                        onClick={() => onOpenModal(proposal)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-300 bg-white hover:bg-stone-50 text-stone-700 text-xs font-medium cursor-pointer transition-colors"
                      >
                        <Sliders className="w-3.5 h-3.5 text-stone-500" />
                        <span>Review in Modal</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onRejectProposal(proposal)}
                        className="flex items-center gap-1 px-3.5 py-1.5 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 text-xs font-medium cursor-pointer transition-colors"
                      >
                        <XCircle className="w-3.5 h-3.5 text-rose-600" />
                        <span>Reject</span>
                      </button>

                      <button
                        id={`approve-start-trade-${proposal.id}`}
                        onClick={() => onApproveProposal(proposal)}
                        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-xs cursor-pointer transition-colors"
                        title="Authorize proposal and immediately start live trade execution"
                      >
                        <Play className="w-3.5 h-3.5 fill-white text-white" />
                        <span>Approve & Start Trade</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Approved Trade Active Feedback */}
                {isApproved && (
                  <div className="mt-4 pt-3 border-t border-emerald-200/70 flex flex-wrap items-center justify-between gap-2 bg-emerald-50/70 -mx-4 -mb-4 p-3 rounded-b-xl">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-2.5 w-2.5 relative">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                      </span>
                      <span className="text-xs font-bold text-emerald-900">
                        Trade Started by Agent &bull; Position Active &amp; Managed Live
                      </span>
                    </div>
                    <button
                      onClick={() => onInspectProposal(proposal)}
                      className="flex items-center gap-1.5 px-3 py-1 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-semibold cursor-pointer transition-colors shadow-xs"
                    >
                      <span>View on Live Chart</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
