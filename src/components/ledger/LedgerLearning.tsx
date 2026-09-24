import React, { useEffect, useMemo, useState } from "react";
import { Download, ChevronRight } from "lucide-react";
import type { ExperienceVector, PromotedLabModel } from "../../types";
import {
  COIN_FLIP_BRIER,
  MIN_REAL_TRADES,
  computeLearningBreakdowns,
  computeLearningStats,
  type WinRateBucket,
} from "../../services/learningStats";
import { Card, RoundIconButton, StatTile } from "./ui";
import { shadowStore, summarizeShadows, type ShadowSignal } from "../../services/shadowTracker";
import { SKIP_REASON_LABEL, type SkipReason } from "../../services/scanOutcome";

export interface LedgerLearningProps {
  experiences: ExperienceVector[];
  /** Closed trades autopilot opened. */
  autopilotTrades: number;
  autopilotWins: number;
  promotedLabModel: PromotedLabModel | null;
  onOpenLab: () => void;
  /** Shadow-tracked setups. Omit to follow the live store. */
  shadows?: ShadowSignal[];
}

/** Resolved setups a row needs before its numbers are shown. */
const MIN_SHADOW_SAMPLE = 5;

const signedR = (r: number) => `${r >= 0 ? "+" : "\u2212"}${Math.abs(r).toFixed(2)}R`;

/**
 * What happened to setups the scanner found: the proposed ones next to each
 * reason for skipping. A skip reason whose setups reach their target about
 * as often as proposed ones is a filter costing you trades.
 */
export const SkippedSetups: React.FC<{ shadows: ShadowSignal[] }> = ({ shadows }) => {
  const rows = useMemo(() => summarizeShadows(shadows), [shadows]);
  const open = shadows.filter((s) => s.status === "open").length;
  return (
    <Card aria-label="What skipped setups did" className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-semibold">What skipped setups did</div>
        <div className="text-xs text-muted mt-0.5 leading-relaxed">
          Every setup is followed on real prices until it would have hit its target or stop (intraday ones for 30 minutes).
          {open > 0 && ` ${open} still being followed.`}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">Nothing tracked yet. Setups appear here as the scanner finds them.</p>
      ) : (
        <div className="flex flex-col" role="table" aria-label="Outcome by reason">
          <div role="row" className="grid grid-cols-[1fr_auto_auto] gap-3 text-[11px] text-muted pb-1.5 border-b border-line">
            <span role="columnheader">Setups</span>
            <span role="columnheader" className="text-right w-14">Hit target</span>
            <span role="columnheader" className="text-right w-14">Avg result</span>
          </div>
          {rows.map((r) => {
            const enough = r.resolved >= MIN_SHADOW_SAMPLE;
            const label = r.kind === "proposed" ? "Proposed" : SKIP_REASON_LABEL[r.kind as SkipReason] ?? r.kind;
            return (
              <div role="row" key={r.kind} className="grid grid-cols-[1fr_auto_auto] gap-3 items-baseline py-2 border-b border-line last:border-b-0 text-[13px] tabular-nums">
                <span role="cell" className="min-w-0">
                  <span className={r.kind === "proposed" ? "font-semibold" : ""}>{label}</span>
                  <span className="block text-[11px] text-muted">
                    {r.resolved} of {r.tracked} finished
                  </span>
                </span>
                <span role="cell" className="text-right w-14">{enough && r.targetPct !== null ? `${r.targetPct}%` : "—"}</span>
                <span
                  role="cell"
                  className={`text-right w-14 ${enough && r.avgR !== null ? (r.avgR >= 0 ? "text-gain" : "text-loss") : ""}`}
                >
                  {enough && r.avgR !== null ? signedR(r.avgR) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="m-0 text-xs text-muted leading-relaxed">
        Results are after fees; a candle that touched both stop and target counts as the stop. Numbers show once {MIN_SHADOW_SAMPLE} setups
        of a kind have finished.
      </p>
    </Card>
  );
};

const LiveSkippedSetups: React.FC = () => {
  const [shadows, setShadows] = useState<ShadowSignal[]>(() => shadowStore.all());
  useEffect(() => shadowStore.subscribe(() => setShadows(shadowStore.all())), []);
  return <SkippedSetups shadows={shadows} />;
};

const FAMILY: Record<string, string> = {
  trend_following: "Trend following",
  breakout_confirmation: "Breakout",
  mean_reversion: "Mean reversion",
  volatility_filter: "Volatility",
  event_news_filter: "News",
};

const REGIME: Record<string, string> = {
  trending_bullish: "Trending up",
  trending_bearish: "Trending down",
  ranging_tight: "Tight range",
  ranging_wide: "Wide range",
  high_volatility_choppy: "Choppy",
};

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

const Bars: React.FC<{ title: string; rows: WinRateBucket[]; labels: Record<string, string> }> = ({ title, rows, labels }) => (
  <Card className="flex flex-col gap-3.5">
    <div className="text-sm font-semibold">{title}</div>
    {rows.map((r) => (
      <div key={r.key} className="flex flex-col gap-1.5">
        <div className="flex justify-between gap-3 text-[13px] tabular-nums">
          <span>{labels[r.key] ?? r.key}</span>
          <span>
            <strong>{r.winRatePct}%</strong> <span className="text-muted">of {r.trades}</span>
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-inset overflow-hidden">
          <div
            className={`h-full rounded-full ${r.winRatePct >= 50 ? "bg-gain" : "bg-loss"}`}
            style={{ width: `${r.winRatePct}%` }}
          />
        </div>
      </div>
    ))}
  </Card>
);

const Quad: React.FC<{ n: number; top: string; bottom: string; tone: string }> = ({ n, top, bottom, tone }) => (
  <div className="bg-inset rounded-[10px] p-2.5">
    <div className={`font-display text-[22px] tabular-nums ${tone}`}>{n}</div>
    <div className="text-[11px] text-muted leading-snug">
      {top}
      <br />
      {bottom}
    </div>
  </div>
);

export const LedgerLearning: React.FC<LedgerLearningProps> = (props) => {
  const { experiences } = props;
  const stats = useMemo(() => computeLearningStats(experiences), [experiences]);
  const breakdowns = useMemo(() => computeLearningBreakdowns(experiences), [experiences]);
  const total = experiences.length;
  const d = breakdowns.decisions;
  const classified = d.goodCallGoodResult + d.goodCallBadLuck + d.badCallLuckyWin + d.badCallBadResult;

  const change =
    stats.recentWinRatePct !== null && stats.earlyWinRatePct !== null ? stats.recentWinRatePct - stats.earlyWinRatePct : null;
  // How much better than always saying 50% the win probabilities are.
  const calibration = stats.brierScore === null ? null : ((COIN_FLIP_BRIER - stats.brierScore) / COIN_FLIP_BRIER) * 100;

  const exportMemory = () => {
    const blob = new Blob([JSON.stringify(experiences, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nexus-memory-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const lab = props.promotedLabModel;
  const autopilotWinPct = props.autopilotTrades > 0 ? Math.round((props.autopilotWins / props.autopilotTrades) * 100) : null;

  return (
    <div className="font-ui text-ink flex flex-col gap-4 pb-4 select-none">
      <header className="flex items-center justify-between gap-3 pt-1">
        <div className="min-w-0">
          <h1 className="m-0 font-display text-[26px] font-semibold">Learning</h1>
          <div className="text-[13px] text-muted">What the desk has learned from your trades</div>
        </div>
        <RoundIconButton label="Export memory" onClick={exportMemory}>
          <Download className="w-[18px] h-[18px]" strokeWidth={1.6} />
        </RoundIconButton>
      </header>

      <Card aria-label="Memory" className="flex flex-col gap-3">
        <div className="flex justify-between items-baseline gap-3">
          <div className="text-sm font-semibold">Memory</div>
          <div className="text-xs text-muted tabular-nums">{total.toLocaleString("en-IN")} examples</div>
        </div>
        <div className="flex h-2.5 rounded-full overflow-hidden gap-0.5 bg-inset" aria-hidden="true">
          {stats.realCount > 0 && <div className="bg-accent" style={{ flexGrow: stats.realCount }} />}
          {stats.seededCount > 0 && <div className="bg-line" style={{ flexGrow: stats.seededCount }} />}
        </div>
        <div className="flex justify-between gap-3 text-xs tabular-nums">
          <span>
            <strong className="text-accent">{stats.realCount}</strong> your real trades
          </span>
          <span className="text-muted">{stats.seededCount} seeded examples</span>
        </div>
        {stats.enough ? (
          <div className="flex gap-2">
            <StatTile label="Real win rate" value={pct(stats.winRatePct)} />
            <StatTile
              label="Recent trades"
              value={pct(stats.recentWinRatePct)}
              valueClassName={change !== null && change > 0 ? "text-gain" : change !== null && change < 0 ? "text-loss" : ""}
            />
            <StatTile label="Worst drop" value={stats.maxDrawdownPct === null ? "—" : `${stats.maxDrawdownPct.toFixed(1)}%`} />
          </div>
        ) : (
          <p className="m-0 text-[13px] text-muted leading-relaxed">
            Learning is measured on real trades only. It needs {MIN_REAL_TRADES}; you have {stats.realCount} so far. Until
            then the win rates behind proposals lean on the seeded examples.
          </p>
        )}
      </Card>

      {stats.enough && (
        <Card aria-label="Is it improving" className="flex flex-col gap-2.5">
          <div className="text-sm font-semibold">Is it getting better?</div>
          <div className="flex justify-between gap-3 text-[13px] tabular-nums">
            <span>Win rate, first trades → recent</span>
            <span>
              {pct(stats.earlyWinRatePct)} → {pct(stats.recentWinRatePct)}{" "}
              {change !== null && (
                <strong className={change > 0 ? "text-gain" : change < 0 ? "text-loss" : ""}>
                  ({change > 0 ? "+" : change < 0 ? "−" : ""}
                  {Math.abs(Math.round(change))} pts)
                </strong>
              )}
            </span>
          </div>
          <div className="flex justify-between gap-3 text-[13px] tabular-nums">
            <span>Called the direction right</span>
            <span>{pct(stats.directionalAccuracyPct)}</span>
          </div>
          <div className="flex justify-between gap-3 text-[13px] tabular-nums">
            <span>Win chances vs a coin flip</span>
            <span className={calibration !== null && calibration < 0 ? "text-loss" : ""}>
              {calibration === null ? "—" : `${calibration >= 0 ? "" : "−"}${Math.abs(Math.round(calibration))}% ${calibration >= 0 ? "better" : "worse"}`}
            </span>
          </div>
        </Card>
      )}

      {stats.enough && breakdowns.byFamily.length > 0 && (
        <Bars title="Win rate by strategy · your trades" rows={breakdowns.byFamily} labels={FAMILY} />
      )}
      {stats.enough && breakdowns.byRegime.length > 0 && (
        <Bars title="Win rate by market · your trades" rows={breakdowns.byRegime} labels={REGIME} />
      )}

      {stats.enough && classified > 0 && (
        <Card aria-label="Decision vs outcome" className="flex flex-col gap-3">
          <div className="text-sm font-semibold">Decision vs outcome</div>
          <div className="grid grid-cols-2 gap-2">
            <Quad n={d.goodCallGoodResult} top="Good call" bottom="good result" tone="text-gain" />
            <Quad n={d.goodCallBadLuck} top="Good call" bottom="bad luck" tone="text-ink" />
            <Quad n={d.badCallLuckyWin} top="Bad call" bottom="lucky win" tone="text-warn" />
            <Quad n={d.badCallBadResult} top="Bad call" bottom="bad result" tone="text-loss" />
          </div>
          <p className="m-0 text-xs text-muted leading-relaxed">
            A good call can still lose. The desk learns from the bad calls, not the bad luck.
          </p>
        </Card>
      )}

      {props.shadows !== undefined ? <SkippedSetups shadows={props.shadows} /> : <LiveSkippedSetups />}

      <Card className="flex flex-col py-1">
        <div className="flex items-center justify-between gap-3 min-h-12 py-2 border-b border-line text-sm">
          <span>Autopilot's record</span>
          <span className="text-muted tabular-nums">
            {props.autopilotTrades === 0
              ? "No closed trades yet"
              : `${props.autopilotWins} of ${props.autopilotTrades} closed trades won (${autopilotWinPct}%)`}
          </span>
        </div>
        <button
          type="button"
          onClick={props.onOpenLab}
          className="w-full flex items-center justify-between gap-3 min-h-12 py-2 text-sm text-left cursor-pointer"
        >
          <span className="min-w-0">
            <span className="block">Model in use</span>
            <span className="block text-xs text-muted mt-0.5 truncate">
              {lab ? `Lab model · ${lab.datasetName} · ${lab.winRatePct.toFixed(0)}% win rate in testing` : "Live learning only · no Lab model promoted"}
            </span>
          </span>
          <ChevronRight className="w-4 h-4 text-muted shrink-0" />
        </button>
      </Card>
    </div>
  );
};
