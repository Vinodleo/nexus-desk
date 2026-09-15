import React from "react";
import {
  TrendingUp,
  TrendingDown,
  XCircle,
  Clock,
  CheckCircle2,
  DollarSign,
  Layers,
  ArrowRight,
} from "lucide-react";
import { Position } from "../types";

interface ActivePositionsAndOrdersProps {
  positions: Position[];
  onClosePosition: (pos: Position) => void;
  recentClosedTrades: any[];
}

export const ActivePositionsAndOrders: React.FC<ActivePositionsAndOrdersProps> = ({
  positions,
  onClosePosition,
  recentClosedTrades,
}) => {
  return (
    <div id="active-positions-orders" className="space-y-4">
      {/* Open Positions */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
        <div className="flex items-center justify-between pb-2 border-b border-stone-200 mb-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-emerald-600" />
            <h4 className="font-semibold text-xs text-stone-900">
              Active Open Positions ({positions.length}/3)
            </h4>
          </div>
          <span className="text-[11px] text-stone-500 font-mono">
            Unrealized P&L:{" "}
            <strong
              className={
                positions.reduce((acc, p) => acc + p.unrealizedPnl, 0) >= 0
                  ? "text-emerald-600"
                  : "text-rose-600"
              }
            >
              {positions.reduce((acc, p) => acc + p.unrealizedPnl, 0) >= 0 ? "+" : "-"}₹
              {Math.abs(positions.reduce((acc, p) => acc + p.unrealizedPnl, 0)).toLocaleString("en-IN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </strong>
          </span>
        </div>

        {positions.length === 0 ? (
          <div className="py-6 text-center text-stone-400 text-xs font-mono">
            No active positions open. System is scanning predefined setups.
          </div>
        ) : (
          <div className="space-y-2">
            {positions.map((pos) => {
              const isProfit = pos.unrealizedPnl >= 0;
              const isLong = pos.direction === "LONG";

              return (
                <div
                  key={pos.id}
                  className="p-3 bg-stone-50 rounded-lg border border-stone-200 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                        isLong ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                      }`}
                    >
                      {pos.direction}
                    </span>
                    <div>
                      <span className="font-bold text-stone-900">{pos.symbol}</span>
                      <span className="text-stone-500 text-[11px] ml-2">
                        {pos.quantity} units @ ₹{pos.entryPrice.toFixed(2)}
                      </span>
                    </div>
                  </div>

                  {/* Target & Stop */}
                  <div className="flex items-center gap-4 font-mono text-[11px] text-stone-600">
                    <span>
                      Stop: <strong className="text-rose-600">₹{pos.stopLoss.toFixed(2)}</strong>
                    </span>
                    <span>
                      Target: <strong className="text-emerald-600">₹{pos.takeProfit.toFixed(2)}</strong>
                    </span>
                    <span>
                      Current: <strong>₹{pos.currentPrice.toFixed(2)}</strong>
                    </span>
                  </div>

                  {/* P&L and Close action */}
                  <div className="flex items-center gap-3 font-mono">
                    <span
                      className={`font-bold text-xs ${
                        isProfit ? "text-emerald-600" : "text-rose-600"
                      }`}
                    >
                      {isProfit ? "+" : "-"}₹{Math.abs(pos.unrealizedPnl).toFixed(2)} ({isProfit ? "+" : ""}
                      {pos.unrealizedPnlPercent.toFixed(2)}%)
                    </span>

                    <button
                      onClick={() => onClosePosition(pos)}
                      className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded font-semibold text-[11px] cursor-pointer transition-colors"
                      title="Closes position and runs Trade Autopsy Agent"
                    >
                      Close & Autopsy
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Closed Trades with 4-Way Classification */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
        <div className="flex items-center justify-between pb-2 border-b border-stone-200 mb-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-stone-600" />
            <h4 className="font-semibold text-xs text-stone-900">
              Recent Execution & Autopsy Log
            </h4>
          </div>
          <span className="text-[10px] text-stone-500">Live Paper Fills</span>
        </div>

        <div className="space-y-2">
          {recentClosedTrades.map((t, idx) => (
            <div
              key={`closed-${idx}`}
              className="p-2.5 bg-stone-50 rounded-lg border border-stone-200 flex flex-wrap items-center justify-between gap-2 text-xs font-mono"
            >
              <div className="flex items-center gap-2">
                <span className="font-bold text-stone-800">{t.symbol}</span>
                <span className="text-[11px] text-stone-500 font-sans">{t.setupName}</span>
              </div>

              <div className="flex items-center gap-3">
                <span className={t.pnl >= 0 ? "text-emerald-600 font-bold" : "text-rose-600 font-bold"}>
                  {t.pnl >= 0 ? "+" : "-"}₹{Math.abs(t.pnl).toFixed(2)}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-sans font-medium ${
                    t.classification === "good_decision_good_outcome"
                      ? "bg-emerald-100 text-emerald-800"
                      : t.classification === "good_decision_bad_outcome"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-rose-100 text-rose-800"
                  }`}
                >
                  {t.classification?.replace(/_/g, " ")}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
