import React from "react";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Radio,
  Power,
  TrendingUp,
  Cpu,
  Layers,
  AlertTriangle,
  Clock,
  Flame,
} from "lucide-react";
import { DecisionMode, FailureInjectionState } from "../types";

interface HeaderProps {
  decisionMode: DecisionMode;
  setDecisionMode: (mode: DecisionMode) => void;
  equity: number;
  dailyRealizedPnl: number;
  dailyUnrealizedPnl: number;
  dailyLossLimit: number;
  failureState: FailureInjectionState;
  toggleKillSwitch: () => void;
  championVersion: string;
  challengerVersion: string;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isStale: boolean;
  pendingProposalsCount?: number;
  onGoToQueue?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  decisionMode,
  setDecisionMode,
  equity,
  dailyRealizedPnl,
  dailyUnrealizedPnl,
  dailyLossLimit,
  failureState,
  toggleKillSwitch,
  championVersion,
  challengerVersion,
  activeTab,
  setActiveTab,
  isStale,
  pendingProposalsCount = 0,
  onGoToQueue,
}) => {
  const totalDailyPnl = dailyRealizedPnl + dailyUnrealizedPnl;
  const isLossApproaching = dailyRealizedPnl < -dailyLossLimit * 0.75;
  const isLossBreached = dailyRealizedPnl <= -dailyLossLimit || failureState.simulateDailyLossBreach;

  return (
    <header id="app-header" className="border-b border-stone-200 bg-stone-900 text-stone-100 shadow-sm sticky top-0 z-40">
      {/* Top Banner: Status and Risk Telemetry */}
      <div className="max-w-7xl mx-auto px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
        {/* Brand & Blueprint Indicator */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-bold">
              v2
            </div>
            <div>
              <div className="font-semibold text-sm tracking-tight text-stone-100 flex items-center gap-1.5">
                Self-Learning Trading Bot
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/60 font-mono">
                  v2.0 Rigorous
                </span>
              </div>
              <div className="text-[11px] text-stone-400">
                Paper-Trading • Statistical Meta-Labeling • Purged Walk-Forward
              </div>
            </div>
          </div>

          {/* Model Status */}
          <div className="hidden md:flex items-center gap-2 pl-3 border-l border-stone-800">
            <div className="flex items-center gap-1 px-2 py-1 rounded bg-stone-800/80 border border-stone-700">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-stone-400">Champion:</span>
              <span className="font-mono text-stone-200">{championVersion}</span>
            </div>
            <div className="flex items-center gap-1 px-2 py-1 rounded bg-stone-800/80 border border-stone-700">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              <span className="text-stone-400">Challenger:</span>
              <span className="font-mono text-stone-200">{challengerVersion}</span>
            </div>
          </div>
        </div>

        {/* Real-time Account & Risk Telemetry */}
        <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
          {/* Equity */}
          <div className="bg-stone-800/90 border border-stone-700/80 px-2.5 py-1 rounded-md">
            <div className="text-[10px] text-stone-400">Paper Equity</div>
            <div className="font-mono font-medium text-stone-100 text-xs">
              ₹{equity.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          {/* Daily P&L */}
          <div className="bg-stone-800/90 border border-stone-700/80 px-2.5 py-1 rounded-md">
            <div className="text-[10px] text-stone-400">Daily P&L (Realized / Unrealized)</div>
            <div className={`font-mono font-medium text-xs flex items-center gap-1 ${totalDailyPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {totalDailyPnl >= 0 ? "+" : "-"}₹{Math.abs(totalDailyPnl).toFixed(2)}
              <span className="text-[10px] text-stone-400 font-normal">
                (₹{dailyRealizedPnl.toFixed(1)} / ₹{dailyUnrealizedPnl.toFixed(1)})
              </span>
            </div>
          </div>

          {/* Daily Loss Guard */}
          <div className={`px-2.5 py-1 rounded-md border flex items-center gap-1.5 ${
            isLossBreached
              ? "bg-rose-950/80 border-rose-700 text-rose-300"
              : isLossApproaching
              ? "bg-amber-950/80 border-amber-700 text-amber-300"
              : "bg-stone-800/90 border-stone-700/80 text-stone-300"
          }`}>
            <Shield className="w-3.5 h-3.5" />
            <div>
              <div className="text-[10px] opacity-75">Daily Loss Limit</div>
              <div className="font-mono text-xs">
                ₹{Math.abs(Math.min(0, dailyRealizedPnl)).toFixed(0)} / ₹{dailyLossLimit.toLocaleString("en-IN")}
              </div>
            </div>
          </div>

          {/* Data Health & Kill Switch */}
          <div className="flex items-center gap-2">
            {isStale || failureState.simulateStaleMarketData ? (
              <div className="flex items-center gap-1 px-2 py-1 rounded bg-rose-950/90 border border-rose-800 text-rose-300 text-[11px]">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>STALE DATA</span>
              </div>
            ) : (
              <div className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-950/60 border border-emerald-800/60 text-emerald-300 text-[11px]">
                <Radio className="w-3 h-3 text-emerald-400" />
                <span>DATA OK</span>
              </div>
            )}

            {/* Global Kill Switch (Section 8) */}
            <button
              id="global-kill-switch-btn"
              onClick={toggleKillSwitch}
              className={`flex items-center gap-1 px-2.5 py-1 rounded font-medium text-xs transition-colors cursor-pointer ${
                failureState.globalKillSwitchActive
                  ? "bg-rose-600 hover:bg-rose-700 text-white animate-pulse"
                  : "bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700"
              }`}
              title="Global Kill Switch stops all new orders and enforces fail-closed state."
            >
              <Power className="w-3.5 h-3.5" />
              <span>{failureState.globalKillSwitchActive ? "KILL SWITCH ENGAGED" : "Kill Switch"}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Navigation Tabs and Autonomy Mode Selector */}
      <div className="bg-stone-950 px-4 border-t border-stone-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
        <nav className="flex items-center space-x-1 overflow-x-auto py-1.5">
          <button
            id="tab-trading-room"
            onClick={() => setActiveTab("trading-room")}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
              activeTab === "trading-room"
                ? "bg-stone-800 text-emerald-400 border border-stone-700"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            Live Stage & Chart
          </button>
          <button
            id="tab-approval-queue"
            onClick={() => {
              setActiveTab("trading-room");
              onGoToQueue?.();
            }}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
              pendingProposalsCount > 0
                ? "bg-amber-950/80 text-amber-300 border border-amber-600 shadow-xs"
                : "text-stone-400 hover:text-stone-200"
            }`}
            title="View trades queued by agents awaiting human authorization"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Approval Queue</span>
            {pendingProposalsCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-amber-400 text-stone-900 animate-pulse">
                {pendingProposalsCount}
              </span>
            )}
          </button>
          <button
            id="tab-decision-pipeline"
            onClick={() => setActiveTab("decision-pipeline")}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
              activeTab === "decision-pipeline"
                ? "bg-stone-800 text-emerald-400 border border-stone-700"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            Section 5 Decision Flow
          </button>
          <button
            id="tab-multi-agent"
            onClick={() => setActiveTab("multi-agent")}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
              activeTab === "multi-agent"
                ? "bg-stone-800 text-emerald-400 border border-stone-700"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            AI Multi-Agent Studio
          </button>
          <button
            id="tab-experience-memory"
            onClick={() => setActiveTab("experience-memory")}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
              activeTab === "experience-memory"
                ? "bg-stone-800 text-emerald-400 border border-stone-700"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            Experience Database & Autopsies
          </button>
          <button
            id="tab-backtest-validation"
            onClick={() => setActiveTab("backtest-validation")}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
              activeTab === "backtest-validation"
                ? "bg-stone-800 text-emerald-400 border border-stone-700"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            Purged Walk-Forward & Promotion Gate
          </button>
          <button
            id="tab-risk-safety"
            onClick={() => setActiveTab("risk-safety")}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
              activeTab === "risk-safety"
                ? "bg-stone-800 text-emerald-400 border border-stone-700"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            Risk Engine & Failure Injection
          </button>
        </nav>

        {/* Section 9: Human Approval & Autonomy Selector */}
        <div className="flex items-center gap-1.5 py-1 text-stone-300">
          <span className="text-[11px] text-stone-400 font-medium">Autonomy Policy:</span>
          <div className="inline-flex rounded-md bg-stone-900 p-0.5 border border-stone-800">
            <button
              id="mode-manual-btn"
              onClick={() => setDecisionMode("MANUAL")}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all cursor-pointer ${
                decisionMode === "MANUAL"
                  ? "bg-emerald-600 text-white shadow-xs"
                  : "text-stone-400 hover:text-stone-200"
              }`}
              title="Manual: All trades require explicit human approval."
            >
              Manual
            </button>
            <button
              id="mode-semiauto-btn"
              onClick={() => setDecisionMode("SEMI_AUTO")}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all cursor-pointer ${
                decisionMode === "SEMI_AUTO"
                  ? "bg-emerald-600 text-white shadow-xs"
                  : "text-stone-400 hover:text-stone-200"
              }`}
              title="Semi-Auto: High-confidence low-risk trades execute; others require approval."
            >
              Semi-Auto
            </button>
            <button
              id="mode-auto-btn"
              onClick={() => setDecisionMode("AUTO_WITHIN_LIMITS")}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all cursor-pointer ${
                decisionMode === "AUTO_WITHIN_LIMITS"
                  ? "bg-amber-600 text-white shadow-xs"
                  : "text-stone-400 hover:text-stone-200"
              }`}
              title="Auto within limits: Approved setups execute within strict risk budget."
            >
              Auto (Limits)
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
