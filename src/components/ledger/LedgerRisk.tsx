import React, { useState } from "react";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import type { CoinDcxServerStatus, FailureInjectionState, RiskCalculation } from "../../types";
import { apiFetch } from "../../services/apiClient";
import { GrowBar } from "./motion";
import { Card, Switch } from "./ui";
import { formatMoney } from "./format";

export interface LedgerRiskProps {
  riskCalc: RiskCalculation;
  failureState: FailureInjectionState;
  onUpdateFailureState: (key: keyof FailureInjectionState, val: boolean) => void;
  onResetFailures: () => void;
  stopped: boolean;
  onToggleStop: () => void;
  coinDcxStatus: CoinDcxServerStatus | null;
  onRefreshCoinDcxStatus?: () => Promise<void>;
  onRefreshBalance?: () => Promise<unknown>;
}

const Meter: React.FC<{ label: string; value: string; fraction: number }> = ({ label, value, fraction }) => {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const tone = f >= 1 ? "bg-loss" : f >= 0.8 ? "bg-warn" : "bg-accent";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between gap-3 text-[13px] tabular-nums">
        <span>{label}</span>
        <span className="text-muted">{value}</span>
      </div>
      <div
        className={`h-1.5 rounded-full bg-inset overflow-hidden${f >= 1 ? " nx-pulse-slow" : f >= 0.8 ? " nx-pulse-few" : ""}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(f * 100)}
      >
        {/* Grows in, then glides; near the limit it pulses a few times, at the limit slowly for good. */}
        <GrowBar fraction={f} className={tone} />
      </div>
    </div>
  );
};

const Heading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-xs font-semibold text-muted uppercase tracking-[0.08em] px-1">{children}</div>
);

const DRILLS: { key: keyof FailureInjectionState; label: string; sub: string }[] = [
  { key: "simulateStaleMarketData", label: "Stale market data", sub: "Pretend prices stopped updating" },
  { key: "simulateDailyLossBreach", label: "Daily loss limit hit", sub: "Pretend today's losses reached the limit" },
  { key: "simulateOrderBookThinLiquidity", label: "Thin order book", sub: "Pretend there are too few buyers and sellers" },
];

export const LedgerRisk: React.FC<LedgerRiskProps> = (props) => {
  const { riskCalc: r, coinDcxStatus: status } = props;
  const live = status?.liveRisk;
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "ok" | "failed"; error?: string }>({ state: "idle" });
  const drillsOn = DRILLS.some((d) => props.failureState[d.key]);
  // The drills block trades inside the risk engine, which the summary check
  // above doesn't include, so count them here.
  const passing = r.passedAllChecks && !drillsOn;
  const blockedReason = !r.passedAllChecks ? r.rejectionReason : "A safety drill is on.";

  const checkKeys = async () => {
    setCheck({ state: "checking" });
    try {
      const res = await apiFetch("/api/coindcx/validate-keys", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setCheck({ state: "ok" });
        await props.onRefreshBalance?.();
      } else {
        setCheck({ state: "failed", error: data.error || "CoinDCX rejected the keys. Check their permissions." });
      }
      await props.onRefreshCoinDcxStatus?.();
    } catch (err: any) {
      setCheck({ state: "failed", error: err?.message || "Couldn't reach CoinDCX." });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        className={`flex items-start gap-2.5 p-3.5 rounded-2xl text-sm ${
          passing ? "bg-accent-soft text-accent" : "bg-danger-soft text-loss border border-danger-line"
        }`}
      >
        {passing ? (
          <CheckCircle2 className="w-5 h-5 shrink-0" strokeWidth={1.8} />
        ) : (
          <XCircle className="w-5 h-5 shrink-0" strokeWidth={1.8} />
        )}
        <span>
          <strong>{passing ? "All checks passing." : "New trades blocked."}</strong>{" "}
          {passing ? "New trades can open within the limits below." : blockedReason}
        </span>
      </div>

      <Heading>Limits</Heading>
      <Card className="flex flex-col gap-4">
        <Meter
          label="Daily loss"
          value={`${formatMoney(r.currentDailyLoss, { decimals: 0 })} of ${formatMoney(r.hardDailyLossLimit, { decimals: 0 })}`}
          fraction={r.hardDailyLossLimit > 0 ? r.currentDailyLoss / r.hardDailyLossLimit : 0}
        />
        <Meter
          label="Exposure"
          value={`${(r.portfolioExposureFraction * 100).toFixed(1)}% of ${(r.maxAllowedExposureFraction * 100).toFixed(0)}%`}
          fraction={r.maxAllowedExposureFraction > 0 ? r.portfolioExposureFraction / r.maxAllowedExposureFraction : 0}
        />
        <Meter
          label="Open positions"
          value={`${r.openPositionCount} of ${r.maxSimultaneousPositions}`}
          fraction={r.maxSimultaneousPositions > 0 ? r.openPositionCount / r.maxSimultaneousPositions : 0}
        />
        <div className="flex justify-between gap-3 text-[13px] tabular-nums">
          <span>Most a trade can risk</span>
          <span className="text-muted">
            {(r.maxRiskPerTradeFraction * 100).toFixed(1)}% · {formatMoney(r.equity * r.maxRiskPerTradeFraction, { decimals: 0 })}
          </span>
        </div>
      </Card>

      <Heading>Live orders on CoinDCX</Heading>
      <Card className="flex flex-col gap-4">
        <div className="flex justify-between gap-3 text-[13px]">
          <span>Server allows live orders</span>
          <span className={`font-semibold ${live?.enabled ? "text-warn" : "text-muted"}`}>
            {live ? (live.enabled ? "Yes" : "No") : "Unknown"}
          </span>
        </div>
        {live && typeof live.maxDailyOrders === "number" && (
          <>
            <Meter
              label="Orders today"
              value={`${live.openedOrdersToday} of ${live.maxDailyOrders}`}
              fraction={live.maxDailyOrders > 0 ? live.openedOrdersToday / live.maxDailyOrders : 0}
            />
            <Meter
              label="Traded today"
              value={`${formatMoney(live.openedNotionalInrToday, { decimals: 0 })} of ${formatMoney(live.maxDailyNotionalInr, { decimals: 0 })}`}
              fraction={live.maxDailyNotionalInr > 0 ? live.openedNotionalInrToday / live.maxDailyNotionalInr : 0}
            />
            <div className="flex justify-between gap-3 text-[13px] tabular-nums">
              <span>Largest single order</span>
              <span className="text-muted">{formatMoney(live.maxOrderNotionalInr, { decimals: 0 })}</span>
            </div>
          </>
        )}
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={checkKeys}
            disabled={check.state === "checking" || !status?.configured}
            className="self-start min-h-10 px-4 rounded-full border border-line bg-surface text-[13px] font-semibold flex items-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {check.state === "checking" && <Loader2 className="w-4 h-4 animate-spin" />}
            {check.state === "checking" ? "Checking with CoinDCX…" : "Check CoinDCX keys"}
          </button>
          {!status?.configured && status && (
            <span className="text-xs text-muted">No CoinDCX keys on the server yet.</span>
          )}
          {check.state === "ok" && <span className="text-xs text-gain">CoinDCX accepted the keys.</span>}
          {check.state === "failed" && <span className="text-xs text-loss">{check.error}</span>}
        </div>
      </Card>

      <Heading>Safety drills</Heading>
      <Card className="flex flex-col py-1">
        <p className="m-0 py-2.5 text-xs text-muted leading-relaxed border-b border-line">
          Each drill fakes a problem so you can see the safety checks block new trades. Nothing real changes.
        </p>
        <div className="flex items-center justify-between gap-3 min-h-12 py-2 border-b border-line text-sm">
          <div>
            <div>Stop all trading</div>
            <div className="text-xs text-muted mt-0.5">The same switch as Stop all on the Floor</div>
          </div>
          <Switch checked={props.stopped} onChange={props.onToggleStop} label="Stop all trading" />
        </div>
        {DRILLS.map((d, i) => (
          <div
            key={d.key}
            className={`flex items-center justify-between gap-3 min-h-12 py-2 text-sm ${i < DRILLS.length - 1 ? "border-b border-line" : ""}`}
          >
            <div>
              <div>{d.label}</div>
              <div className="text-xs text-muted mt-0.5">{d.sub}</div>
            </div>
            <Switch
              checked={props.failureState[d.key]}
              onChange={(on) => props.onUpdateFailureState(d.key, on)}
              label={d.label}
            />
          </div>
        ))}
      </Card>
      {drillsOn && (
        <button
          type="button"
          onClick={props.onResetFailures}
          className="min-h-11 rounded-full border border-line bg-surface text-sm font-semibold cursor-pointer"
        >
          Turn off all drills
        </button>
      )}
    </div>
  );
};
