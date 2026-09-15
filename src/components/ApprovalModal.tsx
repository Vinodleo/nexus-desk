import React, { useState, useEffect } from "react";
import {
  ShieldCheck,
  Clock,
  CheckCircle2,
  XCircle,
  Key,
  DollarSign,
  AlertTriangle,
  FileText,
} from "lucide-react";
import { TradeProposal } from "../types";

interface ApprovalModalProps {
  proposal: TradeProposal;
  isOpen: boolean;
  onApprove: (proposal: TradeProposal) => void;
  onReject: (proposal: TradeProposal) => void;
  onExpire: (proposal: TradeProposal) => void;
}

export const ApprovalModal: React.FC<ApprovalModalProps> = ({
  proposal,
  isOpen,
  onApprove,
  onReject,
  onExpire,
}) => {
  const [secondsRemaining, setSecondsRemaining] = useState(45);

  useEffect(() => {
    if (!isOpen) {
      setSecondsRemaining(45);
      return;
    }

    const interval = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          onExpire(proposal);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isOpen, proposal, onExpire]);

  if (!isOpen) return null;

  const isLong = proposal.setup.direction === "LONG";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/60 backdrop-blur-xs p-4">
      <div
        id="approval-modal"
        className="bg-white rounded-2xl shadow-xl max-w-lg w-full border border-stone-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Header */}
        <div className="bg-stone-900 text-stone-100 p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <div>
              <h3 className="font-semibold text-sm">Section 9: Trade Authorization Request</h3>
              <div className="text-[11px] text-stone-400 font-mono">
                Proposal ID: {proposal.id}
              </div>
            </div>
          </div>

          {/* Expiry Countdown */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-stone-800 border border-stone-700 font-mono text-xs text-amber-300">
            <Clock className="w-3.5 h-3.5 animate-spin" />
            <span>{secondsRemaining}s Expiry</span>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* Section 9 Expiry Policy Notice */}
          <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
            <span>
              <strong>Fail-Closed Policy:</strong> If you do not respond before the timer reaches 0, the proposal automatically expires to <strong>NO TRADE</strong>.
            </span>
          </div>

          {/* Trade Parameters Summary Card */}
          <div className="p-3 bg-stone-50 rounded-xl border border-stone-200 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm text-stone-900">{proposal.symbol}</span>
                <span
                  className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                    isLong ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                  }`}
                >
                  LIMIT {proposal.setup.direction}
                </span>
              </div>
              <span className="text-stone-500 font-mono text-[11px]">
                R:R Ratio <strong>{proposal.setup.riskRewardRatio}x</strong>
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 font-mono text-center pt-1 border-t border-stone-200">
              <div className="p-1.5 bg-white rounded border border-stone-200">
                <span className="text-[10px] text-stone-400 block">Limit Entry</span>
                <span className="font-bold text-stone-800">${proposal.setup.entryPrice.toFixed(2)}</span>
              </div>
              <div className="p-1.5 bg-white rounded border border-stone-200">
                <span className="text-[10px] text-rose-500 block">Stop Loss</span>
                <span className="font-bold text-rose-700">${proposal.setup.stopLoss.toFixed(2)}</span>
              </div>
              <div className="p-1.5 bg-white rounded border border-stone-200">
                <span className="text-[10px] text-emerald-500 block">Take Profit</span>
                <span className="font-bold text-emerald-700">${proposal.setup.takeProfit.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Sizing & Statistical Metrics */}
          <div className="grid grid-cols-2 gap-3 font-mono">
            <div className="p-2.5 bg-stone-50 rounded-lg border border-stone-200">
              <span className="text-stone-500 text-[10px] block">Quarter-Kelly Position:</span>
              <span className="font-bold text-stone-900 text-xs">
                {proposal.riskCalc.recommendedPositionSizeUnits} units (${proposal.riskCalc.recommendedDollarExposure})
              </span>
            </div>
            <div className="p-2.5 bg-stone-50 rounded-lg border border-stone-200">
              <span className="text-stone-500 text-[10px] block">Capped Max Dollar Risk:</span>
              <span className="font-bold text-emerald-700 text-xs">
                ${proposal.riskCalc.riskDollars} (1.0% equity)
              </span>
            </div>
            <div className="p-2.5 bg-stone-50 rounded-lg border border-stone-200">
              <span className="text-stone-500 text-[10px] block">Meta-Confidence (Sec 6F):</span>
              <span className="font-bold text-indigo-700 text-xs">
                {(proposal.metaScore.confidence * 100).toFixed(1)}%
              </span>
            </div>
            <div className="p-2.5 bg-stone-50 rounded-lg border border-stone-200">
              <span className="text-stone-500 text-[10px] block">Expected Net Value:</span>
              <span className="font-bold text-emerald-700 text-xs">
                +${proposal.evAssessment.expectedNetValue}
              </span>
            </div>
          </div>

          {/* Authorization Token */}
          <div className="p-2 bg-stone-100 rounded border border-stone-200 flex items-center justify-between text-[11px] font-mono text-stone-600">
            <div className="flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5 text-stone-500" />
              <span>Auth Token:</span>
            </div>
            <span className="font-semibold text-stone-800">
              {proposal.approvalToken || "AUTH-TOKEN-7F89B2"}
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="p-4 bg-stone-50 border-t border-stone-200 flex items-center justify-end gap-2.5">
          <button
            id="reject-proposal-btn"
            onClick={() => onReject(proposal)}
            className="px-4 py-2 bg-stone-200 hover:bg-stone-300 text-stone-700 font-semibold rounded-lg text-xs cursor-pointer transition-colors"
          >
            Reject / Pass
          </button>
          <button
            id="approve-proposal-btn"
            onClick={() => onApprove(proposal)}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg text-xs shadow-xs cursor-pointer transition-colors flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>Authorize & Start Trade</span>
          </button>
        </div>
      </div>
    </div>
  );
};
