import React, { useState } from "react";
import {
  Filter,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  BarChart3,
  Layers,
  ShieldAlert,
  ArrowRight,
  Clock,
} from "lucide-react";

export interface SkipRecord {
  id: string;
  ticker: string;
  direction: "long" | "short";
  pattern: string;
  regime: string;
  metaScore: string;
  reason: string;
  details: {
    adx: number;
    volumeSurge: string;
    calibratedPWin: number;
    evScore: string;
    vetoStage: "META_LABEL" | "RISK_LIMIT" | "REGIME_SHOCK" | "SUPERVISOR";
  };
}

export interface RejectionBreakdown {
  metaHurdle: number;
  riskEngine: number;
  regimeFilter: number;
  supervisorVeto: number;
}

interface FloorTabProps {
  onOpenLab: () => void;
  onWakeCommander: () => void;
  takenCount?: number;
  skippedCount?: number;
  labEv?: string;
  analyzedCount?: number;
  selectedCount?: number;
  rejectedCount?: number;
  rejectionBreakdown?: RejectionBreakdown;
  dailyRealizedPnl?: number;
}

export const FloorTab: React.FC<FloorTabProps> = ({
  onOpenLab,
  onWakeCommander,
  takenCount = 0,
  skippedCount = 0,
  labEv = "+0.37R",
  analyzedCount = 0,
  selectedCount = 0,
  rejectedCount = 0,
  rejectionBreakdown = {
    metaHurdle: 0,
    riskEngine: 0,
    regimeFilter: 0,
    supervisorVeto: 0,
  },
  dailyRealizedPnl = 0,
}) => {
  const [showFunnelDetails, setShowFunnelDetails] = useState<boolean>(true);
  const [selectedSkipId, setSelectedSkipId] = useState<string | null>(null);

  const totalEvaluated = analyzedCount;
  const passRate =
    totalEvaluated > 0
      ? ((selectedCount / totalEvaluated) * 100).toFixed(1)
      : "0.0";
  const rejectRate =
    totalEvaluated > 0
      ? ((rejectedCount / totalEvaluated) * 100).toFixed(1)
      : "0.0";

  // Rejection percentages
  const metaPct =
    rejectedCount > 0
      ? Math.round((rejectionBreakdown.metaHurdle / rejectedCount) * 100)
      : 0;
  const riskPct =
    rejectedCount > 0
      ? Math.round((rejectionBreakdown.riskEngine / rejectedCount) * 100)
      : 0;
  const regimePct =
    rejectedCount > 0
      ? Math.round((rejectionBreakdown.regimeFilter / rejectedCount) * 100)
      : 0;
  const superPct =
    rejectedCount > 0
      ? Math.round((rejectionBreakdown.supervisorVeto / rejectedCount) * 100)
      : 0;

  const skipItems: SkipRecord[] = [];

  return (
    <div className="space-y-4 pb-20 select-none">
      {/* 1. Live Playbook Card (Screenshots 5, 7) */}
      <div className="rounded-2xl bg-[#0e0e11] border border-[#222227] p-5 sm:p-6 space-y-4 shadow-xl">
        <div>
          <span className="text-[10px] font-mono tracking-[0.2em] text-stone-400 uppercase">
            Live Playbook · Breakout-V2.0
          </span>
          <h2 className="font-serif text-2xl sm:text-3xl text-stone-100 font-normal mt-1">
            Confirmed breakout
          </h2>
          <p className="text-xs text-stone-400 font-sans mt-1">
            Frozen entry. Meta can only cut size or veto. Champion rules locked.
          </p>
        </div>

        <button
          onClick={onOpenLab}
          className="w-full py-2.5 rounded-xl bg-[#18181e] hover:bg-[#202028] border border-[#2c2c36] text-stone-200 text-xs font-mono tracking-wider transition-all cursor-pointer text-center"
        >
          Open the lab
        </button>

        {/* 4-cell stats grid with Live Sample data */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-[#1a1a20]">
          <div>
            <div className="text-[10px] font-mono text-stone-500 uppercase tracking-wider">
              Lab EV
            </div>
            <div className="text-sm font-mono font-medium text-emerald-400 mt-0.5">
              {labEv}{" "}
              <span className="text-[11px] text-stone-400 font-normal">
                47 trades
              </span>
            </div>
          </div>

          {/* Live Sample Cell with Interactive Telemetry (24h IST Window: 12:00 AM - 11:59 PM) */}
          <div
            onClick={() => setShowFunnelDetails(!showFunnelDetails)}
            className="cursor-pointer group"
          >
            <div className="flex items-center gap-1 text-[10px] font-mono text-stone-500 uppercase tracking-wider group-hover:text-stone-300 transition-colors">
              <span>Live Sample</span>
              <span className="text-[9px] px-1 py-0.2 bg-[#1b1b22] rounded text-emerald-400/90 border border-emerald-800/40">
                24h IST
              </span>
              <span className="text-[9px] px-1 py-0.2 bg-[#1b1b22] rounded text-stone-400 border border-stone-800">
                {showFunnelDetails ? "Hide" : "Audit"}
              </span>
            </div>
            <div className="text-sm font-mono font-medium text-stone-100 mt-0.5 group-hover:text-white transition-colors">
              {analyzedCount} analysed
            </div>
            <div className="text-[11px] font-mono text-stone-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span className="text-emerald-400 font-medium">
                {selectedCount} selected
              </span>
              <span>·</span>
              <span className="text-rose-400 font-medium">
                {rejectedCount} rejected
              </span>
            </div>
          </div>

          <div>
            <div className="text-[10px] font-mono text-stone-500 uppercase tracking-wider">
              Last Skip
            </div>
            <div className="text-sm font-mono font-medium text-stone-300 mt-0.5">
              risk · quiet
            </div>
          </div>

          <div>
            <div className="text-[10px] font-mono text-stone-500 uppercase tracking-wider">
              Gate
            </div>
            <div className="text-sm font-mono font-medium text-emerald-300 mt-0.5">
              Ready to promote
            </div>
          </div>
        </div>

        {/* Live Sample Agent Analysis Funnel (Interactive Drawer / Panel) */}
        {showFunnelDetails && (
          <div className="mt-3 pt-3 border-t border-[#1b1b22] space-y-3 animate-in fade-in duration-200">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
              <div className="flex items-center gap-1.5">
                <BarChart3 className="w-3.5 h-3.5 text-stone-400" />
                <span className="text-[11px] font-mono tracking-wider text-stone-300 uppercase font-semibold">
                  Agent Pipeline Telemetry
                </span>
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#161d28] border border-cyan-800/40 text-cyan-300 flex items-center gap-1">
                  <Clock className="w-2.5 h-2.5" />
                  <span>24h IST Window (12:00 AM – 11:59 PM)</span>
                </span>
              </div>
              <span className="text-[10px] font-mono text-stone-500">
                Resets daily at 00:00 IST · 14 Pairs
              </span>
            </div>

            {/* 3-Column Visual Metrics: Analysed -> Selected -> Rejected */}
            <div className="grid grid-cols-3 gap-2 text-center">
              {/* Analysed Card */}
              <div className="p-2.5 rounded-xl bg-[#121217] border border-[#24242e] flex flex-col justify-between">
                <span className="text-[10px] font-mono text-stone-400 uppercase tracking-wider">
                  Analysed
                </span>
                <span className="text-lg font-mono font-semibold text-stone-100 mt-1">
                  {analyzedCount}
                </span>
                <span className="text-[10px] font-mono text-stone-500 mt-0.5">
                  100% evaluated
                </span>
              </div>

              {/* Selected Card */}
              <div className="p-2.5 rounded-xl bg-[#0f1712] border border-emerald-900/40 flex flex-col justify-between">
                <div className="flex items-center justify-center gap-1 text-[10px] font-mono text-emerald-400 uppercase tracking-wider">
                  <CheckCircle2 className="w-3 h-3" />
                  <span>Selected</span>
                </div>
                <span className="text-lg font-mono font-semibold text-emerald-400 mt-1">
                  {selectedCount}
                </span>
                <span className="text-[10px] font-mono text-emerald-500/80 mt-0.5">
                  {passRate}% pass rate
                </span>
              </div>

              {/* Rejected Card */}
              <div className="p-2.5 rounded-xl bg-[#191012] border border-rose-900/40 flex flex-col justify-between">
                <div className="flex items-center justify-center gap-1 text-[10px] font-mono text-rose-400 uppercase tracking-wider">
                  <XCircle className="w-3 h-3" />
                  <span>Rejected</span>
                </div>
                <span className="text-lg font-mono font-semibold text-rose-400 mt-1">
                  {rejectedCount}
                </span>
                <span className="text-[10px] font-mono text-rose-500/80 mt-0.5">
                  {rejectRate}% filtered
                </span>
              </div>
            </div>

            {/* Proportional Rejection Progress Bar */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-[10px] font-mono text-stone-400">
                <span>Veto & Rejection Breakdown ({rejectedCount} Total)</span>
                <span>Fail-Closed Filter Engine</span>
              </div>

              <div className="h-2 w-full bg-[#181820] rounded-full overflow-hidden flex">
                <div
                  style={{ width: `${metaPct}%` }}
                  className="h-full bg-amber-500/80"
                  title={`Meta-label veto: ${rejectionBreakdown.metaHurdle} trades (${metaPct}%)`}
                />
                <div
                  style={{ width: `${riskPct}%` }}
                  className="h-full bg-rose-500/80"
                  title={`Risk engine veto: ${rejectionBreakdown.riskEngine} trades (${riskPct}%)`}
                />
                <div
                  style={{ width: `${regimePct}%` }}
                  className="h-full bg-cyan-500/80"
                  title={`Regime shock filter: ${rejectionBreakdown.regimeFilter} trades (${regimePct}%)`}
                />
                <div
                  style={{ width: `${superPct}%` }}
                  className="h-full bg-purple-500/80"
                  title={`Supervisor veto/timeout: ${rejectionBreakdown.supervisorVeto} trades (${superPct}%)`}
                />
              </div>

              {/* Breakdown Legend Grid */}
              <div className="grid grid-cols-2 gap-2 text-[11px] font-mono pt-1">
                <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-[#121217] border border-[#1e1e26]">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-400" />
                    <span className="text-stone-300">Meta Hurdle (&lt;0.52)</span>
                  </div>
                  <span className="text-stone-400 font-semibold">
                    {rejectionBreakdown.metaHurdle}{" "}
                    <span className="text-stone-600 font-normal">
                      ({metaPct}%)
                    </span>
                  </span>
                </div>

                <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-[#121217] border border-[#1e1e26]">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-rose-400" />
                    <span className="text-stone-300">Risk & Kelly Limit</span>
                  </div>
                  <span className="text-stone-400 font-semibold">
                    {rejectionBreakdown.riskEngine}{" "}
                    <span className="text-stone-600 font-normal">
                      ({riskPct}%)
                    </span>
                  </span>
                </div>

                <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-[#121217] border border-[#1e1e26]">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-cyan-400" />
                    <span className="text-stone-300">Regime Shock / Spread</span>
                  </div>
                  <span className="text-stone-400 font-semibold">
                    {rejectionBreakdown.regimeFilter}{" "}
                    <span className="text-stone-600 font-normal">
                      ({regimePct}%)
                    </span>
                  </span>
                </div>

                <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-[#121217] border border-[#1e1e26]">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-purple-400" />
                    <span className="text-stone-300">Supervisor / Timeout</span>
                  </div>
                  <span className="text-stone-400 font-semibold">
                    {rejectionBreakdown.supervisorVeto}{" "}
                    <span className="text-stone-600 font-normal">
                      ({superPct}%)
                    </span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 2. 24h Profit Summary */}
      <div className="rounded-xl bg-gradient-to-r from-[#0d0d10] to-[#121217] border border-[#1b1b22] p-5 shadow-sm flex flex-col justify-center">
        <h2 className="text-[10px] font-mono tracking-[0.2em] text-stone-500 uppercase mb-1">
          24h Profit (12AM - 11:59PM)
        </h2>
        <div className={`text-2xl sm:text-3xl font-mono tracking-tight font-medium ${dailyRealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
          {dailyRealizedPnl >= 0 ? "+" : "-"}₹{Math.abs(dailyRealizedPnl).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>

      {/* 3. Specialists Section (Screenshots 4, 7) */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-sm font-sans font-semibold text-stone-200">
            Specialists
          </h3>
          <span className="text-[10px] font-mono tracking-wider text-stone-400">
            {selectedCount} SELECTED · {rejectedCount} REJECTED ·{" "}
            {analyzedCount} ANALYSED
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {/* Card: SCAN */}
          <div className="rounded-xl bg-[#0f0f13] border border-[#202026] p-4 space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono text-stone-400">
              <span className="tracking-wider uppercase">SCAN</span>
              <span className="text-[10px] text-stone-400">Awaiting Data</span>
            </div>
            <div className="space-y-1 text-xs font-mono text-stone-400">
              Engine active, scanning global universe...
            </div>
          </div>

          {/* Card: SETUPS */}
          <div className="rounded-xl bg-[#0f0f13] border border-[#202026] p-4 space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono text-stone-400">
              <span className="tracking-wider uppercase">SETUPS</span>
              <span className="text-[10px] text-stone-400">
                {analyzedCount} Scanned
              </span>
            </div>
            <div className="space-y-1 text-xs font-mono text-stone-400">
              Awaiting robust candidates...
            </div>
          </div>

          {/* Card: NEWS */}
          <div className="rounded-xl bg-[#0f0f13] border border-[#202026] p-4 space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono text-stone-400">
              <span className="tracking-wider uppercase">NEWS</span>
            </div>
            <div className="text-xs font-mono text-stone-400 leading-relaxed font-sans">
              Waiting for news flow aggregation...
            </div>
          </div>

          {/* Card: WHALES */}
          <div className="rounded-xl bg-[#0f0f13] border border-[#202026] p-4 space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono text-stone-400">
              <span className="tracking-wider uppercase">WHALES</span>
            </div>
            <div className="text-xs font-mono text-stone-400">
              Monitoring block trades and volume spikes...
            </div>
          </div>

          {/* Card: RISK */}
          <div className="rounded-xl bg-[#0f0f13] border border-[#202026] p-4 space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono text-stone-400">
              <span className="tracking-wider uppercase">RISK · 45</span>
              <span className="text-[10px] text-emerald-400">
                Hurdle P≥0.52
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div>
                <span className="text-stone-500 text-[10px]">Gross: </span>
                <span className="text-stone-200">0%</span>
              </div>
              <div>
                <span className="text-stone-500 text-[10px]">Names: </span>
                <span className="text-stone-200">0/5</span>
              </div>
              <div className="col-span-2 text-stone-400">
                Model: <span className="text-stone-200">champion</span> · BTC{" "}
                <span className="text-stone-200">77,344.98</span>
              </div>
            </div>
          </div>

          {/* Card: COMMANDER */}
          <div className="rounded-xl bg-[#0f0f13] border border-[#202026] p-4 space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono text-stone-400">
              <span className="tracking-wider uppercase">COMMANDER · 20</span>
            </div>
            <div className="text-xs font-mono font-medium text-stone-200">
              CHAMPION
            </div>
            <p className="text-xs text-stone-400 leading-relaxed font-sans">
              Explains the book. Cannot originate a trade. Timeout is no trade.
            </p>
          </div>
        </div>
      </div>

      {/* 4. Opportunities / Skips Feed with Rejection Audit Details (Screenshot 4) */}
      <div className="space-y-2 pt-2">
        <div className="flex items-baseline justify-between px-1">
          <h3 className="text-sm font-sans font-semibold text-stone-200">
            Opportunities
          </h3>
          <span className="text-[10px] font-mono tracking-wider text-stone-400 uppercase">
            {rejectedCount} SKIPS STORED · IMMUTABLE SAMPLE
          </span>
        </div>

        <div className="space-y-1.5">
          {skipItems.map((skip) => {
            const isExpanded = selectedSkipId === skip.id;
            return (
              <div
                key={skip.id}
                onClick={() =>
                  setSelectedSkipId(isExpanded ? null : skip.id)
                }
                className={`px-3 py-2.5 rounded-xl bg-[#0d0d10] border transition-all cursor-pointer ${
                  isExpanded
                    ? "border-stone-600 bg-[#121217]"
                    : "border-[#1b1b22] hover:border-stone-700"
                }`}
              >
                <div className="flex items-center justify-between text-xs font-mono text-stone-300">
                  <div className="flex items-center gap-2.5">
                    <span className="px-2 py-0.5 rounded bg-[#1c1c24] text-[10px] text-stone-400 tracking-wider font-semibold">
                      SKIP
                    </span>
                    <span className="font-semibold text-white">
                      {skip.ticker}
                    </span>
                    <span
                      className={`text-[11px] uppercase ${
                        skip.direction === "long"
                          ? "text-emerald-400"
                          : "text-rose-400"
                      }`}
                    >
                      {skip.direction}
                    </span>
                    <span className="text-stone-400 truncate">
                      · {skip.pattern} · {skip.regime}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-stone-500 text-[11px] whitespace-nowrap">
                      {skip.metaScore}
                    </span>
                    {isExpanded ? (
                      <ChevronUp className="w-3.5 h-3.5 text-stone-400" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-stone-500" />
                    )}
                  </div>
                </div>

                {/* Reason subtitle */}
                <div className="text-[11px] text-stone-400 mt-1 truncate pl-1 font-sans">
                  {skip.reason}
                </div>

                {/* Expanded Rejection & Audit Telemetry */}
                {isExpanded && (
                  <div className="mt-2.5 pt-2.5 border-t border-[#1f1f28] grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono text-stone-300 animate-in fade-in duration-150">
                    <div className="bg-[#181820] p-2 rounded-lg">
                      <span className="text-stone-500 text-[10px] block">
                        VETO GATE
                      </span>
                      <span className="text-rose-400 font-semibold">
                        {skip.details.vetoStage}
                      </span>
                    </div>
                    <div className="bg-[#181820] p-2 rounded-lg">
                      <span className="text-stone-500 text-[10px] block">
                        CALIBRATED P(WIN)
                      </span>
                      <span
                        className={
                          skip.details.calibratedPWin >= 0.52
                            ? "text-emerald-400"
                            : "text-amber-400 font-semibold"
                        }
                      >
                        {skip.details.calibratedPWin.toFixed(2)} (Hurdle 0.52)
                      </span>
                    </div>
                    <div className="bg-[#181820] p-2 rounded-lg">
                      <span className="text-stone-500 text-[10px] block">
                        EV EXPECTANCY
                      </span>
                      <span className="text-stone-200">
                        {skip.details.evScore}
                      </span>
                    </div>
                    <div className="bg-[#181820] p-2 rounded-lg">
                      <span className="text-stone-500 text-[10px] block">
                        SURGE / ADX
                      </span>
                      <span className="text-stone-200">
                        {skip.details.volumeSurge} · ADX {skip.details.adx}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
