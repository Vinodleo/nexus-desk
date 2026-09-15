import React from "react";
import {
  ShieldAlert,
  ShieldCheck,
  Power,
  AlertTriangle,
  Flame,
  Radio,
  Sliders,
  DollarSign,
  Activity,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { FailureInjectionState, RiskCalculation } from "../types";
import { DEFAULT_RISK_POLICY } from "../services/riskEngine";

interface RiskAndSafetyConsoleProps {
  riskCalc: RiskCalculation;
  failureState: FailureInjectionState;
  onUpdateFailureState: (key: keyof FailureInjectionState, val: boolean) => void;
  onResetFailures: () => void;
  toggleKillSwitch: () => void;
}

export const RiskAndSafetyConsole: React.FC<RiskAndSafetyConsoleProps> = ({
  riskCalc,
  failureState,
  onUpdateFailureState,
  onResetFailures,
  toggleKillSwitch,
}) => {
  return (
    <div id="risk-safety-console" className="space-y-4">
      {/* Top Banner */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-600" />
            <h3 className="font-semibold text-sm text-stone-900">
              Section 8: Deterministic Risk Management & Failure Injection Testbed
            </h3>
          </div>
          <span className="text-xs px-2.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-mono font-medium">
            Strict Code Execution • No Agent Bypass
          </span>
        </div>
        <p className="text-xs text-stone-600">
          "Confidence-scaled position sizing (fractional Kelly) should only reduce risk relative to that fixed 1.0% ceiling, never increase it. Deterministic software calculates position size, risk, costs, limits, and order execution."
        </p>
      </div>

      {/* Live Policy Gauges */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs font-mono">
          <span className="text-[10px] text-stone-500 block">Current Paper Equity</span>
          <div className="text-base font-bold text-stone-900 mt-0.5">
            ₹{riskCalc.equity.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </div>
          <span className="text-[10px] text-stone-400 font-sans block mt-1">100% paper capital</span>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs font-mono">
          <span className="text-[10px] text-stone-500 block">Daily Loss Guard</span>
          <div className="text-base font-bold text-stone-900 mt-0.5">
            ₹{riskCalc.currentDailyLoss.toLocaleString("en-IN", { minimumFractionDigits: 2 })} / ₹{riskCalc.hardDailyLossLimit.toLocaleString("en-IN")}
          </div>
          <span className="text-[10px] text-emerald-600 font-sans block mt-1">
            {riskCalc.currentDailyLoss < riskCalc.hardDailyLossLimit ? "Normal Trading Allowed" : "HALTED"}
          </span>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs font-mono">
          <span className="text-[10px] text-stone-500 block">Max Risk Ceiling / Trade</span>
          <div className="text-base font-bold text-stone-900 mt-0.5">
            {(riskCalc.maxRiskPerTradeFraction * 100).toFixed(1)}% (₹{(riskCalc.equity * 0.01).toLocaleString("en-IN")})
          </div>
          <span className="text-[10px] text-stone-400 font-sans block mt-1">Fixed per-trade cap</span>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs font-mono">
          <span className="text-[10px] text-stone-500 block">Active / Max Positions</span>
          <div className="text-base font-bold text-stone-900 mt-0.5">
            {riskCalc.openPositionCount} / {riskCalc.maxSimultaneousPositions}
          </div>
          <span className="text-[10px] text-stone-400 font-sans block mt-1">Portfolio diversification</span>
        </div>
      </div>

      {/* Failure Injection Testbed (Sections 8 & 17) */}
      <div className="bg-white border border-stone-200 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-stone-200">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-rose-600" />
            <h4 className="font-semibold text-xs text-stone-900">
              Live Failure Injection & Guardrail Verification Suite
            </h4>
          </div>
          <button
            onClick={onResetFailures}
            className="text-xs text-stone-600 hover:text-stone-900 underline cursor-pointer"
          >
            Reset All Simulated Faults
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {/* Failure 1: Global Kill Switch */}
          <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 flex items-center justify-between">
            <div className="space-y-1 pr-4">
              <div className="font-semibold text-stone-900 flex items-center gap-1.5">
                <Power className="w-4 h-4 text-rose-600" />
                <span>Global Kill Switch</span>
              </div>
              <p className="text-[11px] text-stone-500">
                Immediately stops all automated and manual trading. All candidate evaluations fail closed.
              </p>
            </div>
            <button
              onClick={toggleKillSwitch}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                failureState.globalKillSwitchActive
                  ? "bg-rose-600 text-white shadow-xs"
                  : "bg-stone-200 text-stone-700 hover:bg-stone-300"
              }`}
            >
              {failureState.globalKillSwitchActive ? "Active" : "Disabled"}
            </button>
          </div>

          {/* Failure 2: Stale Market Data */}
          <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 flex items-center justify-between">
            <div className="space-y-1 pr-4">
              <div className="font-semibold text-stone-900 flex items-center gap-1.5">
                <Radio className="w-4 h-4 text-amber-600" />
                <span>Simulate Stale Market Data</span>
              </div>
              <p className="text-[11px] text-stone-500">
                Simulates tick feed latency or packet gap. Verifies that stale-data protection blocks orders.
              </p>
            </div>
            <button
              onClick={() => onUpdateFailureState("simulateStaleMarketData", !failureState.simulateStaleMarketData)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                failureState.simulateStaleMarketData
                  ? "bg-amber-600 text-white shadow-xs"
                  : "bg-stone-200 text-stone-700 hover:bg-stone-300"
              }`}
            >
              {failureState.simulateStaleMarketData ? "Active" : "Disabled"}
            </button>
          </div>

          {/* Failure 3: Daily Loss Limit Breach */}
          <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 flex items-center justify-between">
            <div className="space-y-1 pr-4">
              <div className="font-semibold text-stone-900 flex items-center gap-1.5">
                <Flame className="w-4 h-4 text-rose-600" />
                <span>Simulate Daily Loss Limit Breach</span>
              </div>
              <p className="text-[11px] text-stone-500">
                Simulates reaching -₹26,000 daily loss. Verifies system halts new positions for the day.
              </p>
            </div>
            <button
              onClick={() => onUpdateFailureState("simulateDailyLossBreach", !failureState.simulateDailyLossBreach)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                failureState.simulateDailyLossBreach
                  ? "bg-rose-600 text-white shadow-xs"
                  : "bg-stone-200 text-stone-700 hover:bg-stone-300"
              }`}
            >
              {failureState.simulateDailyLossBreach ? "Active" : "Disabled"}
            </button>
          </div>

          {/* Failure 4: Thin Order Book Depth */}
          <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 flex items-center justify-between">
            <div className="space-y-1 pr-4">
              <div className="font-semibold text-stone-900 flex items-center gap-1.5">
                <Activity className="w-4 h-4 text-blue-600" />
                <span>Simulate Thin Order Book Liquidity</span>
              </div>
              <p className="text-[11px] text-stone-500">
                Drops depth score to 15 (below 35 minimum). Verifies Section 7 liquidity filter rejection.
              </p>
            </div>
            <button
              onClick={() => onUpdateFailureState("simulateOrderBookThinLiquidity", !failureState.simulateOrderBookThinLiquidity)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                failureState.simulateOrderBookThinLiquidity
                  ? "bg-blue-600 text-white shadow-xs"
                  : "bg-stone-200 text-stone-700 hover:bg-stone-300"
              }`}
            >
              {failureState.simulateOrderBookThinLiquidity ? "Active" : "Disabled"}
            </button>
          </div>
        </div>

        {/* Live Result of Risk Engine Evaluation */}
        <div className="p-3 bg-stone-100 rounded-lg border border-stone-200 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-stone-700">Current Risk Engine State:</span>
            {riskCalc.passedAllChecks ? (
              <span className="text-emerald-700 font-bold flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" />
                <span>ALL CHECKS PASSING (NORMAL TRADING)</span>
              </span>
            ) : (
              <span className="text-rose-700 font-bold flex items-center gap-1">
                <XCircle className="w-4 h-4" />
                <span>BLOCKED: {riskCalc.rejectionReason}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
