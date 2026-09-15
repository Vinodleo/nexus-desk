import React, { useState, useMemo } from "react";
import { Position, HistoricalTrade } from "../types";
import {
  ArrowUpRight,
  ArrowDownRight,
  ShieldCheck,
  TrendingUp,
  TrendingDown,
  IndianRupee,
  Wallet,
  Clock,
  Sparkles,
  Layers,
  History,
  CheckCircle2,
  AlertOctagon,
  Percent,
} from "lucide-react";

interface BookTabProps {
  positions: Position[];
  closedTrades?: HistoricalTrade[];
  maxPositions?: number;
  onClosePosition: (position: Position) => void;
  onSelectPosition?: (symbol: string) => void;
  onResetTradesToBaseline?: () => void;
}

export const BookTab: React.FC<BookTabProps> = ({
  positions,
  closedTrades = [],
  maxPositions = 5,
  onClosePosition,
  onSelectPosition,
  onResetTradesToBaseline,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<"all" | "open" | "closed">("all");
  const [closedFilter, setClosedFilter] = useState<"ALL" | "WINS" | "LOSSES">("ALL");

  // Open positions calculation
  const totalOpenPnl = positions.reduce(
    (acc, pos) => acc + (pos.unrealizedPnl || 0),
    0
  );
  const totalOpenMoneyPlaced = positions.reduce(
    (acc, pos) => acc + (pos.entryPrice * pos.quantity),
    0
  );
  const isOpenPnlPositive = totalOpenPnl >= 0;

  // Closed trades calculations
  const totalClosedTrades = closedTrades.length;
  const winningTrades = useMemo(
    () => closedTrades.filter((t) => t.isWin || t.realizedPnl >= 0),
    [closedTrades]
  );
  const losingTrades = useMemo(
    () => closedTrades.filter((t) => !t.isWin && t.realizedPnl < 0),
    [closedTrades]
  );

  const totalClosedMoneyPlaced = useMemo(
    () => closedTrades.reduce((acc, t) => acc + (t.moneyPlaced || 0), 0),
    [closedTrades]
  );
  const totalProfitEarned = useMemo(
    () =>
      winningTrades.reduce((acc, t) => acc + Math.max(0, t.realizedPnl), 0),
    [winningTrades]
  );
  const totalMoneyLost = useMemo(
    () =>
      losingTrades.reduce((acc, t) => acc + Math.abs(Math.min(0, t.realizedPnl)), 0),
    [losingTrades]
  );
  const netRealizedPnl = useMemo(
    () => closedTrades.reduce((acc, t) => acc + t.realizedPnl, 0),
    [closedTrades]
  );
  const winRate =
    totalClosedTrades > 0
      ? Math.round((winningTrades.length / totalClosedTrades) * 100)
      : 0;

  // Filtered trades list
  const filteredClosedTrades = useMemo(() => {
    if (closedFilter === "WINS") return winningTrades;
    if (closedFilter === "LOSSES") return losingTrades;
    return closedTrades;
  }, [closedTrades, closedFilter, winningTrades, losingTrades]);

  return (
    <div className="space-y-4 pb-20 select-none">
      {/* Top Header Row with Open & Closed Quick Badges */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 px-1">
        <div>
          <h2 className="text-base font-sans font-semibold text-stone-100 flex items-center gap-2">
            <span>Trading Book</span>
            <span className="text-stone-400 font-mono text-xs font-normal px-2 py-0.5 rounded bg-[#16161d] border border-[#262630]">
              Open: {positions.length}/{maxPositions} • Closed: {totalClosedTrades}
            </span>
          </h2>
          <p className="text-xs text-stone-400 font-sans mt-0.5">
            Active paper positions, money placed, and latest closed profit/loss ledger
          </p>
        </div>

        {/* Global Performance Summary Pill */}
        <div className="flex items-center gap-2 self-start sm:self-auto font-mono text-xs">
          <div className="bg-[#111116] border border-[#202028] px-3 py-1.5 rounded-lg flex items-center gap-2">
            <span className="text-stone-400">Open Unrealized:</span>
            <span
              className={`font-semibold ${
                totalOpenPnl === 0
                  ? "text-stone-300"
                  : isOpenPnlPositive
                  ? "text-emerald-400"
                  : "text-rose-400"
              }`}
            >
              {totalOpenPnl >= 0 ? "+" : "-"}₹{Math.abs(totalOpenPnl).toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Sub-navigation Controls */}
      <div className="flex items-center justify-between gap-2 p-1 bg-[#101015] border border-[#22222c] rounded-xl">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveSubTab("all")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium font-mono transition-all flex items-center gap-1.5 cursor-pointer ${
              activeSubTab === "all"
                ? "bg-[#252532] text-white shadow-sm border border-[#343444]"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Full Ledger</span>
          </button>
          <button
            onClick={() => setActiveSubTab("open")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium font-mono transition-all flex items-center gap-1.5 cursor-pointer ${
              activeSubTab === "open"
                ? "bg-[#252532] text-white shadow-sm border border-[#343444]"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            <Wallet className="w-3.5 h-3.5" />
            <span>Open Positions ({positions.length})</span>
          </button>
          <button
            onClick={() => setActiveSubTab("closed")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium font-mono transition-all flex items-center gap-1.5 cursor-pointer ${
              activeSubTab === "closed"
                ? "bg-[#252532] text-white shadow-sm border border-[#343444]"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>Latest Trades ({totalClosedTrades})</span>
          </button>
        </div>

        {activeSubTab !== "open" && onResetTradesToBaseline && (
          <button
            onClick={onResetTradesToBaseline}
            className="text-[11px] font-mono text-stone-400 hover:text-stone-200 px-2 py-1 rounded hover:bg-[#1a1a24] transition-colors cursor-pointer mr-1"
            title="Reload baseline benchmark trades"
          >
            Reset Trades
          </button>
        )}
      </div>

      {/* 1. OPEN POSITIONS SECTION */}
      {(activeSubTab === "all" || activeSubTab === "open") && (
        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <h3 className="text-xs font-mono font-medium uppercase tracking-wider text-stone-300">
                Active Open Positions ({positions.length})
              </h3>
            </div>
            {positions.length > 0 && (
              <span className="text-[11px] font-mono text-stone-400">
                Capital Placed:{" "}
                <span className="text-stone-200 font-medium">
                  ₹{totalOpenMoneyPlaced.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </span>
            )}
          </div>

          {positions.length === 0 ? (
            <div className="rounded-2xl bg-[#0e0e11] border border-[#202026] p-5 space-y-2">
              <h4 className="text-sm font-sans font-medium text-stone-200">
                No active positions (Flat)
              </h4>
              <p className="text-xs text-stone-400 leading-relaxed font-sans">
                No money is currently at risk. Approve a proposal in the Queue tab or turn on
                Autonomous Self-Approval to deploy capital into live market tickets.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {positions.map((pos) => {
                const isLong = pos.direction === "LONG";
                const isWin = (pos.unrealizedPnl || 0) >= 0;
                const moneyPlaced = pos.entryPrice * pos.quantity;

                return (
                  <div
                    key={pos.id}
                    className="rounded-2xl bg-[#0e0e11] border border-[#22222a] p-4 sm:p-5 space-y-3.5 hover:border-stone-700 transition-all shadow-md"
                  >
                    {/* Symbol & Direction row */}
                    <div className="flex items-center justify-between">
                      <div
                        className="flex items-center gap-2 cursor-pointer"
                        onClick={() => onSelectPosition?.(pos.symbol)}
                      >
                        <span className="text-base font-mono font-semibold text-stone-100">
                          {pos.symbol}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium ${
                            isLong
                              ? "bg-emerald-950/80 text-emerald-300 border border-emerald-800/60"
                              : "bg-rose-950/80 text-rose-300 border border-rose-800/60"
                          }`}
                        >
                          {pos.direction}
                        </span>
                        <span className="text-xs font-mono text-stone-400">
                          {pos.setupName}
                        </span>
                        {pos.isSelfApproved && (
                          <span className="px-1.5 py-0.5 rounded bg-blue-950/60 border border-blue-800/50 text-blue-300 text-[9px] font-mono flex items-center gap-1">
                            <Sparkles className="w-2.5 h-2.5" />
                            AI Swarm
                          </span>
                        )}
                      </div>

                      <button
                        onClick={() => onClosePosition(pos)}
                        className="px-3 py-1 rounded-lg bg-[#191922] hover:bg-[#232330] border border-[#2a2a36] text-[11px] font-mono text-stone-300 hover:text-white transition-all cursor-pointer"
                      >
                        Exit Position
                      </button>
                    </div>

                    {/* Prominent Money Placed & Unrealized PnL Cards */}
                    <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                      {/* Money Placed Box */}
                      <div className="rounded-xl bg-[#14141a] border border-[#262632] p-2.5">
                        <div className="text-[10px] uppercase tracking-wider text-stone-400 flex items-center gap-1">
                          <IndianRupee className="w-3 h-3 text-stone-400" />
                          <span>Money Placed</span>
                        </div>
                        <div className="text-sm font-semibold text-stone-100 mt-1">
                          ₹{moneyPlaced.toLocaleString("en-IN", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </div>
                        <div className="text-[10px] text-stone-400 mt-0.5">
                          {pos.quantity} units @ ₹{pos.entryPrice.toFixed(2)}
                        </div>
                      </div>

                      {/* Current Unrealized PnL Box */}
                      <div
                        className={`rounded-xl border p-2.5 ${
                          isWin
                            ? "bg-emerald-950/30 border-emerald-800/50"
                            : "bg-rose-950/30 border-rose-800/50"
                        }`}
                      >
                        <div className="text-[10px] uppercase tracking-wider flex items-center justify-between">
                          <span
                            className={`flex items-center gap-1 font-semibold ${
                              isWin ? "text-emerald-400" : "text-rose-400"
                            }`}
                          >
                            {isWin ? (
                              <TrendingUp className="w-3 h-3" />
                            ) : (
                              <TrendingDown className="w-3 h-3" />
                            )}
                            {isWin ? "Profit Accrued" : "Current Loss"}
                          </span>
                          <span
                            className={`text-[10px] ${
                              isWin ? "text-emerald-400" : "text-rose-400"
                            }`}
                          >
                            {isWin ? "+" : ""}
                            {pos.unrealizedPnlPercent.toFixed(2)}%
                          </span>
                        </div>
                        <div
                          className={`text-sm font-bold mt-1 ${
                            isWin ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {isWin ? "+" : "-"}₹{Math.abs(pos.unrealizedPnl).toFixed(2)}
                        </div>
                        <div className="text-[10px] text-stone-400 mt-0.5">
                          Mark: ₹{pos.currentPrice.toFixed(2)}
                        </div>
                      </div>
                    </div>

                    {/* Price & Target levels */}
                    <div className="grid grid-cols-2 gap-2 pt-1 border-t border-[#1a1a22] text-xs font-mono text-stone-400">
                      <div>
                        <span className="text-[10px] text-stone-400 uppercase">Stop Loss: </span>
                        <span className="text-rose-400 font-medium">
                          ₹{pos.stopLoss.toFixed(2)}
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] text-stone-400 uppercase">Target (TP): </span>
                        <span className="text-emerald-400 font-medium">
                          ₹{pos.takeProfit.toFixed(2)}
                        </span>
                      </div>
                    </div>

                    {/* Protective Guards Footer */}
                    <div className="flex items-center justify-between text-[11px] font-mono text-stone-400 pt-0.5">
                      <span>Holding: ~{pos.expectedHoldingTimeMinutes}m max</span>
                      <span className="flex items-center gap-1 text-emerald-400/80">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>Hard Limit Protected</span>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* 2. LATEST TRADES SECTION (Realized Profit / Loss Ledger) */}
      {(activeSubTab === "all" || activeSubTab === "closed") && (
        <section className="space-y-3 pt-2">
          {/* Section Header with Win Rate & Net P&L Summary */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-stone-400" />
              <h3 className="text-xs font-mono font-medium uppercase tracking-wider text-stone-300">
                Latest Trades History ({closedTrades.length})
              </h3>
            </div>

            {/* Filter Chips: All, Wins, Losses */}
            <div className="flex items-center gap-1 font-mono text-xs">
              <button
                onClick={() => setClosedFilter("ALL")}
                className={`px-2.5 py-1 rounded-md text-[11px] cursor-pointer transition-all ${
                  closedFilter === "ALL"
                    ? "bg-[#272733] text-white font-medium border border-[#3b3b4d]"
                    : "text-stone-400 hover:text-stone-200"
                }`}
              >
                All ({closedTrades.length})
              </button>
              <button
                onClick={() => setClosedFilter("WINS")}
                className={`px-2.5 py-1 rounded-md text-[11px] cursor-pointer transition-all ${
                  closedFilter === "WINS"
                    ? "bg-emerald-950/80 text-emerald-300 font-medium border border-emerald-700/60"
                    : "text-stone-400 hover:text-emerald-400"
                }`}
              >
                Won ({winningTrades.length})
              </button>
              <button
                onClick={() => setClosedFilter("LOSSES")}
                className={`px-2.5 py-1 rounded-md text-[11px] cursor-pointer transition-all ${
                  closedFilter === "LOSSES"
                    ? "bg-rose-950/80 text-rose-300 font-medium border border-rose-700/60"
                    : "text-stone-400 hover:text-rose-400"
                }`}
              >
                Losses ({losingTrades.length})
              </button>
            </div>
          </div>

          {/* Aggregate Performance Matrix Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
            {/* Money Placed Total */}
            <div className="rounded-xl bg-[#0f0f14] border border-[#202028] p-3">
              <div className="text-[10px] uppercase text-stone-400 tracking-wider">
                Total Placed
              </div>
              <div className="text-sm font-semibold text-stone-100 mt-0.5">
                ₹{totalClosedMoneyPlaced.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </div>
              <div className="text-[10px] text-stone-400 mt-0.5">
                Across {totalClosedTrades} trades
              </div>
            </div>

            {/* Profits Won / Earned */}
            <div className="rounded-xl bg-[#0f0f14] border border-[#202028] p-3">
              <div className="text-[10px] uppercase text-emerald-400/90 tracking-wider flex items-center gap-1">
                <ArrowUpRight className="w-3 h-3 text-emerald-400" />
                <span>Profits Won</span>
              </div>
              <div className="text-sm font-semibold text-emerald-400 mt-0.5">
                +₹{totalProfitEarned.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </div>
              <div className="text-[10px] text-stone-400 mt-0.5">
                {winningTrades.length} winning trades
              </div>
            </div>

            {/* Money Lost */}
            <div className="rounded-xl bg-[#0f0f14] border border-[#202028] p-3">
              <div className="text-[10px] uppercase text-rose-400/90 tracking-wider flex items-center gap-1">
                <ArrowDownRight className="w-3 h-3 text-rose-400" />
                <span>Money Lost</span>
              </div>
              <div className="text-sm font-semibold text-rose-400 mt-0.5">
                -₹{totalMoneyLost.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </div>
              <div className="text-[10px] text-stone-400 mt-0.5">
                {losingTrades.length} losing trades
              </div>
            </div>

            {/* Net Realized & Win Rate */}
            <div className="rounded-xl bg-[#0f0f14] border border-[#202028] p-3">
              <div className="text-[10px] uppercase text-stone-400 tracking-wider flex items-center justify-between">
                <span>Net P&L</span>
                <span className="text-stone-300 font-medium">{winRate}% WR</span>
              </div>
              <div
                className={`text-sm font-bold mt-0.5 ${
                  netRealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {netRealizedPnl >= 0 ? "+" : "-"}₹{Math.abs(netRealizedPnl).toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </div>
              <div className="text-[10px] text-stone-400 mt-0.5">
                {winningTrades.length}W / {losingTrades.length}L
              </div>
            </div>
          </div>

          {/* Closed Trades Cards List */}
          {filteredClosedTrades.length === 0 ? (
            <div className="rounded-2xl bg-[#0e0e11] border border-[#202026] p-6 text-center space-y-2">
              <p className="text-sm text-stone-300 font-medium">
                No trades match the selected filter.
              </p>
              <p className="text-xs text-stone-400">
                Execute or exit positions to record additional trades into the ledger.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredClosedTrades.map((trade) => {
                const isLong = trade.direction === "LONG";
                const isWin = trade.isWin || trade.realizedPnl >= 0;
                const exitReasonLabel =
                  trade.exitReason === "TAKE_PROFIT"
                    ? "Target Hit"
                    : trade.exitReason === "STOP_LOSS"
                    ? "Stop-Loss Hit"
                    : trade.exitReason === "EXPIRY_TIME"
                    ? "Time Horizon"
                    : "Manual Exit";

                return (
                  <div
                    key={trade.id}
                    className="rounded-2xl bg-[#0e0e11] border border-[#22222a] p-4 sm:p-5 space-y-3 hover:border-stone-700 transition-all shadow-md"
                  >
                    {/* Header Row: Symbol, Direction, Setup, Time, Exit Reason */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-mono font-bold text-stone-100">
                          {trade.symbol}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold ${
                            isLong
                              ? "bg-emerald-950/80 text-emerald-300 border border-emerald-800/60"
                              : "bg-rose-950/80 text-rose-300 border border-rose-800/60"
                          }`}
                        >
                          {trade.direction}
                        </span>
                        <span className="text-xs font-mono text-stone-400">
                          {trade.setupName}
                        </span>
                        {trade.isSelfApproved && (
                          <span className="px-1.5 py-0.5 rounded bg-blue-950/50 border border-blue-800/40 text-blue-300 text-[9px] font-mono flex items-center gap-1">
                            <Sparkles className="w-2.5 h-2.5" />
                            Self-Approved
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium ${
                            isWin
                              ? "bg-emerald-950/70 text-emerald-300 border border-emerald-800/60"
                              : "bg-rose-950/70 text-rose-300 border border-rose-800/60"
                          }`}
                        >
                          {exitReasonLabel}
                        </span>
                        <span className="text-[11px] font-mono text-stone-400 flex items-center gap-1">
                          <Clock className="w-3 h-3 text-stone-400" />
                          {trade.closedAt}
                        </span>
                      </div>
                    </div>

                    {/* The Two Core Mandated Displays: MONEY PLACED and PROFIT EARNED / MONEY LOST */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                      {/* Block 1: HOW MUCH MONEY WAS PLACED */}
                      <div className="rounded-xl bg-[#14141b] border border-[#272736] p-3 flex flex-col justify-between">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-mono uppercase tracking-wider text-stone-400 flex items-center gap-1.5">
                            <IndianRupee className="w-3.5 h-3.5 text-stone-400" />
                            Money Placed
                          </span>
                          <span className="text-[10px] font-mono text-stone-400">
                            Capital Invested
                          </span>
                        </div>
                        <div className="my-1.5">
                          <div className="text-lg font-mono font-bold text-white tracking-tight">
                            ₹{trade.moneyPlaced.toLocaleString("en-IN", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </div>
                        </div>
                        <div className="text-[11px] font-mono text-stone-400">
                          {trade.quantity} units @ ₹{trade.entryPrice.toFixed(2)}
                        </div>
                      </div>

                      {/* Block 2: PROFIT EARNED IF WON or MONEY LOST IF LOSS */}
                      <div
                        className={`rounded-xl border p-3 flex flex-col justify-between ${
                          isWin
                            ? "bg-emerald-950/30 border-emerald-800/60"
                            : "bg-rose-950/30 border-rose-800/60"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={`text-[10px] font-mono uppercase tracking-wider font-semibold flex items-center gap-1.5 ${
                              isWin ? "text-emerald-300" : "text-rose-300"
                            }`}
                          >
                            {isWin ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <AlertOctagon className="w-3.5 h-3.5 text-rose-400" />
                            )}
                            {isWin ? "Amount Won" : "Money Lost"}
                          </span>
                          <span
                            className={`text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded ${
                              isWin
                                ? "bg-emerald-900/60 text-emerald-300"
                                : "bg-rose-900/60 text-rose-300"
                            }`}
                          >
                            {isWin ? "+" : ""}
                            {trade.realizedPnlPercent.toFixed(2)}% ROI
                          </span>
                        </div>

                        <div className="my-1.5">
                          <div
                            className={`text-lg font-mono font-bold tracking-tight ${
                              isWin ? "text-emerald-400" : "text-rose-400"
                            }`}
                          >
                            {isWin ? "+" : "-"}₹
                            {Math.abs(trade.realizedPnl).toLocaleString("en-IN", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </div>
                        </div>

                        <div className="text-[11px] font-mono text-stone-400 flex items-center justify-between">
                          <span>
                            {isWin
                              ? "Captured into account capital"
                              : "Deducted from account equity"}
                          </span>
                          <span
                            className={`font-semibold ${
                              isWin ? "text-emerald-400" : "text-rose-400"
                            }`}
                          >
                            {isWin ? "WIN" : "LOSS"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Execution Details Bar: Entry -> Exit, Spread, Duration */}
                    <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[#1a1a24] text-[11px] font-mono text-stone-400">
                      <div>
                        <div className="text-[9px] uppercase tracking-wider text-stone-400">
                          Entry Price
                        </div>
                        <div className="text-stone-200 mt-0.5">
                          ₹{trade.entryPrice.toFixed(2)}
                        </div>
                      </div>

                      <div>
                        <div className="text-[9px] uppercase tracking-wider text-stone-400">
                          Exit Price
                        </div>
                        <div
                          className={`mt-0.5 font-medium ${
                            isWin ? "text-emerald-300" : "text-rose-300"
                          }`}
                        >
                          ₹{trade.exitPrice.toFixed(2)}
                        </div>
                      </div>

                      <div>
                        <div className="text-[9px] uppercase tracking-wider text-stone-400">
                          Holding Time
                        </div>
                        <div className="text-stone-300 mt-0.5">
                          {trade.holdingDurationMinutes || 30} mins
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
