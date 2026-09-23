import React, { useState } from "react";
import {
  Shield,
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
  Key,
  RefreshCw,
  Zap,
  Lock,
  Coins,
  HelpCircle,
} from "lucide-react";
import { FailureInjectionState, RiskCalculation, TradingExecutionMode, CoinDcxAccountBalance, CoinDcxServerStatus } from "../types";
import { DEFAULT_RISK_POLICY } from "../services/riskEngine";
import { apiFetch } from "../services/apiClient";

interface RiskAndSafetyConsoleProps {
  riskCalc: RiskCalculation;
  failureState: FailureInjectionState;
  onUpdateFailureState: (key: keyof FailureInjectionState, val: boolean) => void;
  onResetFailures: () => void;
  toggleKillSwitch: () => void;
  tradingMode?: TradingExecutionMode;
  onToggleTradingMode?: (mode: TradingExecutionMode) => void;
  coinDcxBalance?: CoinDcxAccountBalance;
  coinDcxStatus?: CoinDcxServerStatus | null;
  onRefreshCoinDcxStatus?: () => Promise<void>;
  onRefreshBalance?: () => Promise<any>;
}

export const RiskAndSafetyConsole: React.FC<RiskAndSafetyConsoleProps> = ({
  riskCalc,
  failureState,
  onUpdateFailureState,
  onResetFailures,
  toggleKillSwitch,
  tradingMode = "PAPER",
  onToggleTradingMode,
  coinDcxBalance,
  coinDcxStatus,
  onRefreshCoinDcxStatus,
  onRefreshBalance,
}) => {
  const [testStatus, setTestStatus] = useState<"IDLE" | "TESTING" | "SUCCESS" | "FAILED">("IDLE");
  const [testError, setTestError] = useState<string | null>(null);
  const liveRisk = coinDcxStatus?.liveRisk;

  // Validates the server-held CoinDCX keys by fetching balances with them.
  const handleValidateServerKeys = async () => {
    setTestStatus("TESTING");
    setTestError(null);
    try {
      const res = await apiFetch("/api/coindcx/validate-keys", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setTestStatus("SUCCESS");
        if (onRefreshBalance) await onRefreshBalance();
      } else {
        setTestStatus("FAILED");
        setTestError(data.error || "Authentication failed on CoinDCX. Verify API permissions.");
      }
      if (onRefreshCoinDcxStatus) await onRefreshCoinDcxStatus();
    } catch (err: any) {
      setTestStatus("FAILED");
      setTestError(err.message || "Network error while connecting to CoinDCX");
    }
  };

  const isLive = tradingMode === "LIVE_COINDCX";

  return (
    <div id="risk-safety-console" className="space-y-4">
      {/* Top Banner */}
      <div className="bg-[#121215] border border-[#222227] rounded-xl p-4 shadow-xs text-stone-200">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <h3 className="font-semibold text-sm text-stone-100">
              Section 8: Deterministic Risk Management & Execution Control
            </h3>
          </div>
          <span className="text-xs px-2.5 py-0.5 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-800/60 font-mono font-medium">
            Strict Code Execution • Fail-Closed Architecture
          </span>
        </div>
        <p className="text-xs text-stone-400">
          "Confidence-scaled position sizing (fractional Kelly) reduces risk relative to the fixed 1.0% ceiling.
          Deterministic software calculates position sizing, slippage containment, cost-adjusted expectancy, and exchange routing."
        </p>
      </div>

      {/* ======================================================== */}
      {/* TRADING MODE SELECTOR & COINDCX LIVE EXCHANGE INTEGRATION */}
      {/* ======================================================== */}
      <div className={`rounded-xl border p-4.5 transition-all shadow-sm ${
        isLive
          ? "bg-[#181308] border-amber-500/50 ring-1 ring-amber-500/30"
          : "bg-[#121215] border-[#222227]"
      }`}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[#25252b]">
          <div className="flex items-center gap-2.5">
            {isLive ? (
              <Zap className="w-5 h-5 text-amber-400 animate-pulse" />
            ) : (
              <Shield className="w-5 h-5 text-emerald-400" />
            )}
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold tracking-wide text-white">
                  Trading Execution Mode:
                </span>
                <span className={`text-xs font-mono font-semibold px-2 py-0.5 rounded ${
                  isLive
                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                    : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                }`}>
                  {isLive ? "LIVE COINDCX EXCHANGE" : "PAPER TRADING SIMULATION"}
                </span>
              </div>
              <p className="text-[11px] text-stone-400 mt-0.5">
                {isLive
                  ? "Real HMAC-signed orders routed directly to CoinDCX order endpoints (/exchange/v1/orders/create)."
                  : "Zero risk simulation with realistic 0.02%-0.08% order-book slippage and fee deduction."}
              </p>
            </div>
          </div>

          {/* Toggle Switch */}
          {onToggleTradingMode && (
            <div className="flex items-center gap-2 self-start sm:self-auto bg-[#0a0a0c] p-1 rounded-lg border border-[#2b2b33]">
              <button
                type="button"
                onClick={() => onToggleTradingMode("PAPER")}
                className={`px-3 py-1.5 rounded-md text-xs font-mono font-semibold transition-all cursor-pointer ${
                  !isLive
                    ? "bg-emerald-600 text-white shadow-xs"
                    : "text-stone-400 hover:text-stone-200"
                }`}
              >
                Paper Trading
              </button>
              <button
                type="button"
                onClick={() => onToggleTradingMode("LIVE_COINDCX")}
                className={`px-3 py-1.5 rounded-md text-xs font-mono font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  isLive
                    ? "bg-amber-600 text-white shadow-xs"
                    : "text-stone-400 hover:text-stone-200"
                }`}
              >
                <Zap className="w-3.5 h-3.5" />
                Live CoinDCX
              </button>
            </div>
          )}
        </div>

        {/* Live Exchange Account Balances */}
        {isLive && (
          <div className="mt-3.5 space-y-3">
            <div className="bg-[#1e190d] border border-amber-500/30 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Coins className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-bold font-mono text-amber-200 uppercase tracking-wide">
                    Live CoinDCX Balances (/exchange/v1/users/balances)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {coinDcxBalance?.lastUpdated && (
                    <span className="text-[10px] text-stone-400 font-mono">
                      Updated: {coinDcxBalance.lastUpdated}
                    </span>
                  )}
                  {onRefreshBalance && (
                    <button
                      onClick={() => onRefreshBalance()}
                      disabled={coinDcxBalance?.loading}
                      className="px-2 py-1 bg-amber-950/80 hover:bg-amber-900 border border-amber-600/50 rounded text-[11px] text-amber-300 font-mono flex items-center gap-1 cursor-pointer transition-colors"
                      title="Poll live exchange balances from CoinDCX"
                    >
                      <RefreshCw className={`w-3 h-3 ${coinDcxBalance?.loading ? "animate-spin" : ""}`} />
                      <span>{coinDcxBalance?.loading ? "Polling..." : "Refresh"}</span>
                    </button>
                  )}
                </div>
              </div>

              {coinDcxBalance?.error ? (
                <div className="p-2.5 bg-rose-950/60 border border-rose-800/60 rounded text-rose-300 text-xs flex items-center gap-2 font-mono">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
                  <span>{coinDcxBalance.error}</span>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 font-mono">
                  <div className="bg-[#121008] p-2.5 rounded border border-amber-900/40">
                    <span className="text-[10px] text-amber-400/80 block uppercase">Available INR Cash</span>
                    <span className="text-sm font-bold text-amber-100 block mt-0.5">
                      ₹{(coinDcxBalance?.availableInr ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="bg-[#121008] p-2.5 rounded border border-amber-900/40">
                    <span className="text-[10px] text-amber-400/80 block uppercase">Total INR Balance</span>
                    <span className="text-sm font-bold text-amber-200 block mt-0.5">
                      ₹{(coinDcxBalance?.totalInr ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="bg-[#121008] p-2.5 rounded border border-amber-900/40">
                    <span className="text-[10px] text-amber-400/80 block uppercase">Available USDT</span>
                    <span className="text-sm font-bold text-amber-200 block mt-0.5">
                      ${(coinDcxBalance?.availableUsdt ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="bg-[#121008] p-2.5 rounded border border-amber-900/40">
                    <span className="text-[10px] text-amber-400/80 block uppercase">Locked In Orders</span>
                    <span className="text-sm font-bold text-stone-400 block mt-0.5">
                      ₹{(coinDcxBalance?.lockedInr ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Warning Banner */}
            <div className="p-2.5 bg-amber-950/40 border border-amber-700/40 rounded-lg flex items-start gap-2 text-xs text-amber-200/90 font-sans">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-amber-300">Live Order Dispatch Armed:</span> In live mode, approving candidate setups dispatches real market/limit orders to the exchange.
                The server rejects any order more than <strong>{liveRisk?.maxPriceDeviationPct ?? "—"}%</strong> away from its own last price, and any order breaching the server-side live limits below.
              </div>
            </div>
          </div>
        )}

        {/* CoinDCX server credentials & live limits (read-only; configured via server env) */}
        <div className="mt-3.5 pt-3 border-t border-[#25252b]">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <Key className="w-4 h-4 text-stone-300" />
              <span className="text-xs font-semibold text-stone-200">
                CoinDCX API Credentials (server-held)
              </span>
            </div>
            {coinDcxStatus?.configured ? (
              <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/50 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                Key Configured ({coinDcxStatus.keyMasked})
              </span>
            ) : (
              <span className="text-[10px] font-mono text-rose-300 bg-rose-950/60 px-2 py-0.5 rounded border border-rose-800/50 flex items-center gap-1">
                <XCircle className="w-3 h-3" />
                Not configured
              </span>
            )}
          </div>

          <p className="text-[11px] text-stone-400">
            Keys are read from <code className="text-stone-300">COINDCX_API_KEY</code> / <code className="text-stone-300">COINDCX_API_SECRET</code> on the server and never sent to the browser.
            Live orders additionally require <code className="text-stone-300">LIVE_TRADING_ENABLED=true</code>.
          </p>

          {liveRisk && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2.5 font-mono text-[11px]">
              <div className="bg-[#0d0d10] p-2 rounded border border-[#2b2b33]">
                <span className="text-[10px] text-stone-500 block uppercase">Live Trading</span>
                <span className={liveRisk.enabled ? "text-amber-300 font-bold" : "text-stone-300 font-bold"}>
                  {liveRisk.enabled ? "ENABLED" : "DISABLED"}
                </span>
              </div>
              <div className="bg-[#0d0d10] p-2 rounded border border-[#2b2b33]">
                <span className="text-[10px] text-stone-500 block uppercase">Per-Order Cap</span>
                <span className="text-stone-200">₹{liveRisk.maxOrderNotionalInr.toLocaleString("en-IN")}</span>
              </div>
              <div className="bg-[#0d0d10] p-2 rounded border border-[#2b2b33]">
                <span className="text-[10px] text-stone-500 block uppercase">Daily Notional</span>
                <span className="text-stone-200">
                  ₹{liveRisk.openedNotionalInrToday.toLocaleString("en-IN")} / ₹{liveRisk.maxDailyNotionalInr.toLocaleString("en-IN")}
                </span>
              </div>
              <div className="bg-[#0d0d10] p-2 rounded border border-[#2b2b33]">
                <span className="text-[10px] text-stone-500 block uppercase">Daily Orders</span>
                <span className="text-stone-200">{liveRisk.openedOrdersToday} / {liveRisk.maxDailyOrders}</span>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 mt-2.5 flex-wrap">
            <button
              type="button"
              onClick={handleValidateServerKeys}
              disabled={testStatus === "TESTING" || !coinDcxStatus?.configured}
              className="px-3 py-1.5 bg-stone-800 hover:bg-stone-700 text-stone-100 text-xs font-mono font-medium rounded border border-stone-600 transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Key className="w-3.5 h-3.5 text-amber-400" />
              <span>{testStatus === "TESTING" ? "Validating with CoinDCX..." : "Validate Server Keys"}</span>
            </button>
            {testStatus === "SUCCESS" && (
              <span className="text-xs text-emerald-400 font-mono flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Connection Verified!
              </span>
            )}
            {testStatus === "FAILED" && (
              <span className="text-xs text-rose-400 font-mono flex items-center gap-1">
                <XCircle className="w-3.5 h-3.5" />
                {testError || "Validation Failed"}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Live Policy Gauges */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-[#121215] border border-[#222227] rounded-xl p-3.5 shadow-xs font-mono text-stone-200">
          <span className="text-[10px] text-stone-400 block">
            {isLive ? "Live CoinDCX Equity" : "Current Paper Equity"}
          </span>
          <div className="text-base font-bold text-white mt-0.5">
            {isLive && coinDcxBalance && coinDcxBalance.totalInr > 0
              ? `₹${coinDcxBalance.totalInr.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`
              : `₹${riskCalc.equity.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`}
          </div>
          <span className="text-[10px] text-stone-500 font-sans block mt-1">
            {isLive ? "Real exchange balance" : "100% simulated capital"}
          </span>
        </div>

        <div className="bg-[#121215] border border-[#222227] rounded-xl p-3.5 shadow-xs font-mono text-stone-200">
          <span className="text-[10px] text-stone-400 block">Daily Loss Guard</span>
          <div className="text-base font-bold text-white mt-0.5">
            ₹{riskCalc.currentDailyLoss.toLocaleString("en-IN", { minimumFractionDigits: 2 })} / ₹{riskCalc.hardDailyLossLimit.toLocaleString("en-IN")}
          </div>
          <span className="text-[10px] text-emerald-400 font-sans block mt-1">
            {riskCalc.currentDailyLoss < riskCalc.hardDailyLossLimit ? "Normal Trading Allowed" : "HALTED"}
          </span>
        </div>

        <div className="bg-[#121215] border border-[#222227] rounded-xl p-3.5 shadow-xs font-mono text-stone-200">
          <span className="text-[10px] text-stone-400 block">Max Risk Ceiling / Trade</span>
          <div className="text-base font-bold text-white mt-0.5">
            {(riskCalc.maxRiskPerTradeFraction * 100).toFixed(1)}% (₹{(riskCalc.equity * 0.01).toLocaleString("en-IN")})
          </div>
          <span className="text-[10px] text-stone-500 font-sans block mt-1">Fixed per-trade cap</span>
        </div>

        <div className="bg-[#121215] border border-[#222227] rounded-xl p-3.5 shadow-xs font-mono text-stone-200">
          <span className="text-[10px] text-stone-400 block">Active / Max Positions</span>
          <div className="text-base font-bold text-white mt-0.5">
            {riskCalc.openPositionCount} / {riskCalc.maxSimultaneousPositions}
          </div>
          <span className="text-[10px] text-stone-500 font-sans block mt-1">Portfolio diversification</span>
        </div>
      </div>

      {/* Failure Injection Testbed (Sections 8 & 17) */}
      <div className="bg-[#121215] border border-[#222227] rounded-xl p-5 shadow-xs space-y-4 text-stone-200">
        <div className="flex items-center justify-between pb-2 border-b border-[#25252b]">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-rose-500" />
            <h4 className="font-semibold text-xs text-stone-100">
              Live Failure Injection & Guardrail Verification Suite
            </h4>
          </div>
          <button
            onClick={onResetFailures}
            className="text-xs text-stone-400 hover:text-white underline cursor-pointer"
          >
            Reset All Simulated Faults
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {/* Failure 1: Global Kill Switch */}
          <div className="p-3.5 bg-[#0e0e11] rounded-xl border border-[#25252b] flex items-center justify-between">
            <div className="space-y-1 pr-4">
              <div className="font-semibold text-stone-200 flex items-center gap-1.5">
                <Power className="w-4 h-4 text-rose-500" />
                <span>Global Kill Switch</span>
              </div>
              <p className="text-[11px] text-stone-400">
                Immediately stops all automated and manual trading. All candidate evaluations fail closed.
              </p>
            </div>
            <button
              onClick={toggleKillSwitch}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                failureState.globalKillSwitchActive
                  ? "bg-rose-600 text-white shadow-xs"
                  : "bg-stone-800 text-stone-300 hover:bg-stone-700"
              }`}
            >
              {failureState.globalKillSwitchActive ? "Active" : "Disabled"}
            </button>
          </div>

          {/* Failure 2: Stale Market Data */}
          <div className="p-3.5 bg-[#0e0e11] rounded-xl border border-[#25252b] flex items-center justify-between">
            <div className="space-y-1 pr-4">
              <div className="font-semibold text-stone-200 flex items-center gap-1.5">
                <Radio className="w-4 h-4 text-amber-500" />
                <span>Simulate Stale Market Data</span>
              </div>
              <p className="text-[11px] text-stone-400">
                Simulates tick feed latency or packet gap. Verifies that stale-data protection blocks orders.
              </p>
            </div>
            <button
              onClick={() => onUpdateFailureState("simulateStaleMarketData", !failureState.simulateStaleMarketData)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                failureState.simulateStaleMarketData
                  ? "bg-amber-600 text-white shadow-xs"
                  : "bg-stone-800 text-stone-300 hover:bg-stone-700"
              }`}
            >
              {failureState.simulateStaleMarketData ? "Active" : "Disabled"}
            </button>
          </div>

          {/* Failure 3: Daily Loss Limit Breach */}
          <div className="p-3.5 bg-[#0e0e11] rounded-xl border border-[#25252b] flex items-center justify-between">
            <div className="space-y-1 pr-4">
              <div className="font-semibold text-stone-200 flex items-center gap-1.5">
                <Flame className="w-4 h-4 text-rose-500" />
                <span>Simulate Daily Loss Limit Breach</span>
              </div>
              <p className="text-[11px] text-stone-400">
                Simulates reaching -₹26,000 daily loss. Verifies system halts new positions for the day.
              </p>
            </div>
            <button
              onClick={() => onUpdateFailureState("simulateDailyLossBreach", !failureState.simulateDailyLossBreach)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                failureState.simulateDailyLossBreach
                  ? "bg-rose-600 text-white shadow-xs"
                  : "bg-stone-800 text-stone-300 hover:bg-stone-700"
              }`}
            >
              {failureState.simulateDailyLossBreach ? "Active" : "Disabled"}
            </button>
          </div>

          {/* Failure 4: Thin Order Book Depth */}
          <div className="p-3.5 bg-[#0e0e11] rounded-xl border border-[#25252b] flex items-center justify-between">
            <div className="space-y-1 pr-4">
              <div className="font-semibold text-stone-200 flex items-center gap-1.5">
                <Activity className="w-4 h-4 text-blue-500" />
                <span>Simulate Thin Order Book Liquidity</span>
              </div>
              <p className="text-[11px] text-stone-400">
                Drops depth score to 15 (below 35 minimum). Verifies Section 7 liquidity filter rejection.
              </p>
            </div>
            <button
              onClick={() => onUpdateFailureState("simulateOrderBookThinLiquidity", !failureState.simulateOrderBookThinLiquidity)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                failureState.simulateOrderBookThinLiquidity
                  ? "bg-blue-600 text-white shadow-xs"
                  : "bg-stone-800 text-stone-300 hover:bg-stone-700"
              }`}
            >
              {failureState.simulateOrderBookThinLiquidity ? "Active" : "Disabled"}
            </button>
          </div>
        </div>

        {/* Live Result of Risk Engine Evaluation */}
        <div className="p-3 bg-[#0a0a0c] rounded-lg border border-[#25252b] flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-stone-400">Current Risk Engine State:</span>
            {riskCalc.passedAllChecks ? (
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" />
                <span>ALL CHECKS PASSING (NORMAL TRADING)</span>
              </span>
            ) : (
              <span className="text-rose-400 font-bold flex items-center gap-1">
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
