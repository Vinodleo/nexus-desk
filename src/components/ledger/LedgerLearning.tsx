import React, { useEffect, useMemo, useState } from "react";
import { Download, ChevronRight, FlaskConical } from "lucide-react";
import type { ExperienceVector, PromotedLabModel } from "../../types";
import {
  COIN_FLIP_BRIER,
  MIN_REAL_TRADES,
  computeLearningBreakdowns,
  computeLearningStats,
  learningWindow,
  rollingWinRates,
  type LearningBreakdowns,
  type LearningStats,
} from "../../services/learningStats";
import { Card, RoundIconButton, Segmented, StatTile } from "./ui";
import { shadowStore, summarizeShadows, type ShadowSignal } from "../../services/shadowTracker";
import { SKIP_REASON_LABEL, type SkipReason } from "../../services/scanOutcome";
import { DEFAULT_MIN_CONFIDENCE, MIN_CALIBRATION_SAMPLES, MIN_EDGE_R, buildCalibrator } from "../../services/calibration";
import { MIN_CONDITION_SETUPS, type ConditionBreakdown } from "../../services/conditionStats";
import { RollingDigits, useShown, useSlideFrom } from "./motion";
import { useLabFeed } from "./labFeed";

// The Learning tab, in two parts: what the desk has learned from your real
// trades (its memory, whether it's getting better, the plan for making the
// traders learn, win rates and how good the calls were), and what every
// setup the scanner found did (how true its win chance is, and what the
// skipped ones would have made).

export interface LedgerLearningProps {
  experiences: ExperienceVector[];
  /** Closed trades autopilot opened. */
  autopilotTrades: number;
  autopilotWins: number;
  promotedLabModel: PromotedLabModel | null;
  onOpenLab: () => void;
  /** Shadow-tracked setups. Omit to follow the live store. */
  shadows?: ShadowSignal[];
  /** The time it's shown at (tests); now by default. */
  now?: number;
}

/** Resolved setups a row needs before its numbers are shown. */
const MIN_SHADOW_SAMPLE = 5;

const signedR = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

/** A ring filled to `pct` (0–100), sweeping round when shown. */
const Ring: React.FC<{ pct: number; size: number; width: number; tone: string; testId?: string }> = ({ pct: p, size, width, tone, testId }) => {
  const shown = useShown();
  const r = (size - width) / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90 shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="stroke-inset" strokeWidth={width} />
      <circle
        data-testid={testId}
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        className={tone}
        strokeWidth={width}
        strokeLinecap="round"
        pathLength={100}
        style={{ strokeDasharray: `${shown ? Math.max(0, Math.min(100, p)) : 0} 100`, transition: "stroke-dasharray 1200ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}
      />
    </svg>
  );
};

/** The examples it learns from, rolling up: your real trades against the seeded starter bank, and the headline numbers. */
const MemoryCard: React.FC<{ stats: LearningStats; total: number }> = ({ stats, total }) => {
  const shown = useShown(150);
  const change = stats.recentWinRatePct !== null && stats.earlyWinRatePct !== null ? stats.recentWinRatePct - stats.earlyWinRatePct : null;
  const text = total.toLocaleString("en-IN");
  return (
    <Card aria-label="Memory" className="flex flex-col gap-3">
      <div className="flex justify-between items-baseline gap-3">
        <h2 className="m-0 text-sm font-semibold">Memory</h2>
        <span className="text-xs text-muted">what it learns from</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[44px] leading-[1.1] tabular-nums" data-testid="memory-total">
          <RollingDigits text={shown ? text : text.replace(/\d/g, "0")} />
        </span>
        <span className="text-[13px] text-muted">examples</span>
      </div>
      <div className="flex h-3 rounded-full overflow-hidden gap-[3px] bg-inset" aria-hidden="true">
        {stats.realCount > 0 && <div className="bg-accent rounded-full min-w-2.5 nx-grow" style={{ flexGrow: stats.realCount, animationDelay: "200ms" }} />}
        {stats.seededCount > 0 && <div className="bg-line rounded-full nx-grow" style={{ flexGrow: stats.seededCount, animationDelay: "350ms" }} />}
      </div>
      <div className="flex justify-between gap-3 text-xs tabular-nums">
        <span>
          <strong className="text-accent">{stats.realCount.toLocaleString("en-IN")}</strong> your real trades
        </span>
        <span className="text-muted">{stats.seededCount.toLocaleString("en-IN")} seeded examples</span>
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
          Learning is measured on real trades only. It needs {MIN_REAL_TRADES}; you have {stats.realCount} so far. Until then the win rates
          behind proposals lean on the seeded examples.
        </p>
      )}
    </Card>
  );
};

const W = 300;
const H = 110;

/** The win rate over the last 10 trades, trade by trade, as a line that draws itself; the early and recent windows; direction and calibration. */
const GettingBetter: React.FC<{ stats: LearningStats; rates: number[] }> = ({ stats, rates }) => {
  const change = stats.recentWinRatePct !== null && stats.earlyWinRatePct !== null ? stats.recentWinRatePct - stats.earlyWinRatePct : null;
  // How much better than always saying 50% the win chances are.
  const calibration = stats.brierScore === null ? null : ((COIN_FLIP_BRIER - stats.brierScore) / COIN_FLIP_BRIER) * 100;
  const shown = useShown(300);
  const n = learningWindow(stats.realCount);
  const x = (i: number) => (rates.length > 1 ? (i / (rates.length - 1)) * W : W);
  const y = (r: number) => H - 4 - r * (H - 8);
  const d = rates.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(r).toFixed(1)}`).join(" ");
  const last = rates[rates.length - 1];
  return (
    <Card aria-label="Is it improving" className="flex flex-col gap-3">
      <div className="flex justify-between items-center gap-2">
        <h2 className="m-0 text-sm font-semibold">Is it getting better?</h2>
        {change !== null && (
          <span
            data-testid="improving-change"
            className={`px-2.5 py-0.5 rounded-full text-xs font-bold nx-badge-pop ${change > 0 ? "bg-gain/15 text-gain" : change < 0 ? "bg-loss/15 text-loss" : "bg-inset text-muted"}`}
            style={{ animationDelay: "1200ms" }}
          >
            {change > 0 ? "+" : change < 0 ? "−" : ""}
            {Math.abs(Math.round(change))} pts
          </span>
        )}
      </div>
      {rates.length > 1 && (
        <>
          <div className="text-[13px] text-muted">Win rate over your last 10 trades, trade by trade.</div>
          <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto overflow-visible text-accent" role="img" aria-label="Your win rate, trade by trade" data-testid="win-rate-line">
            <line x1="0" x2={W} y1={y(0.5)} y2={y(0.5)} className="stroke-muted" strokeDasharray="3 4" opacity="0.6" />
            <text x={W} y={y(0.5) - 4} textAnchor="end" fontSize="10" className="fill-muted">
              50%
            </text>
            <path d={`${d} L${W} ${H} L0 ${H} Z`} fill="currentColor" fillOpacity="0.08" className="nx-fade-in" style={{ animationDelay: "800ms" }} />
            <path d={d} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="nx-draw" />
            <circle cx={x(rates.length - 1)} cy={y(last)} r="4" fill="currentColor" className="nx-ring" />
            <circle cx={x(rates.length - 1)} cy={y(last)} r="4" fill="currentColor" className="stroke-surface" strokeWidth="1.5" />
          </svg>
        </>
      )}
      <div className="flex justify-between gap-3 text-xs tabular-nums" data-testid="improving-windows">
        <span className="text-muted">
          First {n} trades <strong className="text-ink">{pct(stats.earlyWinRatePct)}</strong>
        </span>
        <span className="text-muted">
          Last {n} <strong className={change !== null && change > 0 ? "text-gain" : change !== null && change < 0 ? "text-loss" : "text-ink"}>{pct(stats.recentWinRatePct)}</strong>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 border-t border-line pt-3">
        <div className="flex items-center gap-2.5">
          <Ring pct={stats.directionalAccuracyPct ?? 0} size={46} width={6} tone="stroke-accent" testId="direction-ring" />
          <div>
            <div className="font-display text-xl tabular-nums">{pct(stats.directionalAccuracyPct)}</div>
            <div className="text-[11px] text-muted leading-tight">called the direction right</div>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 justify-center">
          <div className="text-[11px] text-muted leading-tight">Its win chances against a coin flip</div>
          <div className="relative h-2 rounded-full bg-inset" aria-hidden="true">
            <span className="absolute left-1/2 -top-[3px] -bottom-[3px] w-px bg-muted" />
            {calibration !== null && (
              <span
                data-testid="coin-flip-bar"
                className={`absolute inset-y-0 rounded-full ${calibration >= 0 ? "bg-gain" : "bg-loss"}`}
                style={{
                  ...(calibration >= 0 ? { left: "50%" } : { right: "50%" }),
                  width: `${shown ? Math.min(50, Math.abs(calibration) / 2) : 0}%`,
                  transition: "width 1200ms cubic-bezier(0.2, 0.8, 0.2, 1)",
                }}
              />
            )}
          </div>
          <div className={`text-[13px] font-bold ${calibration === null ? "text-muted" : calibration >= 0 ? "text-gain" : "text-loss"}`}>
            {calibration === null ? "—" : `${Math.abs(Math.round(calibration))}% ${calibration >= 0 ? "better" : "worse"}`}
          </div>
        </div>
      </div>
    </Card>
  );
};

/** The plan's data-gathering step: how long the scanner's setups go back, and how many condition rows have enough of them. */
export function planProgress(conditions: ConditionBreakdown | null, now: number) {
  if (!conditions || conditions.setups === 0) return null;
  const rows = conditions.groups.flatMap((g) => g.rows);
  const ready = rows.filter((r) => r.all.setups >= MIN_CONDITION_SETUPS).length;
  return {
    day: Math.max(1, Math.floor((now - conditions.since) / 86_400_000) + 1),
    ready,
    rows: rows.length,
    /** Most rows have enough setups: condition filters can be built (the plan's first step). */
    filtersReady: rows.length > 0 && ready * 2 > rows.length,
  };
}

/** About how many days of setups the plan gathers before its first step (3–4 weeks). */
export const PLAN_DAYS = 25;

const PLAN = [
  {
    title: "Gathering data",
    text: `Three to four weeks of setups and trades first, so each condition row of “When setups win” has ${MIN_CONDITION_SETUPS} or more setups behind it before anything changes.`,
  },
  {
    title: "Condition filters",
    text: "Skip the conditions that clearly lose and favour the ones that win, once most rows have enough setups. One PR, when you ask.",
  },
  {
    title: "Self-tuning traders",
    text: "The replay tries a few small changes to each trader's settings and switches only if they also win on recent days they weren't picked from.",
  },
  { title: "More money for proven traders", text: "Each trade sized by its trader's record, always within your limits." },
];

const isEdgeFeed = (body: any): body is { conditions?: ConditionBreakdown | null } => !!body && typeof body === "object" && "table" in body;

/** The plan for making the traders learn, one step at a time: where it stands now, each step's guardrails on a tap. */
export const LearningPlan: React.FC<{ now?: number }> = ({ now: fixedNow }) => {
  const feed = useLabFeed("/api/scanner/exit-edge", isEdgeFeed);
  const progress = planProgress(feed?.conditions ?? null, fixedNow ?? Date.now());
  const [open, setOpen] = useState<number | null>(null);
  const at = progress?.filtersReady ? 1 : 0;
  return (
    <Card aria-label="The learning plan" className="flex flex-col">
      <div className="flex justify-between items-baseline gap-2 mb-3">
        <h2 className="m-0 text-sm font-semibold">The learning plan</h2>
        <span className="text-xs text-muted">one step at a time</span>
      </div>
      <ol className="m-0 p-0 list-none flex flex-col" data-testid="learning-plan">
        {PLAN.map((step, i) => {
          const now = i === at;
          const done = i < at;
          const chip = done ? "Done" : now ? (i === 0 ? "Now" : "Ready to build") : i === at + 1 ? "Next" : "Later";
          const isOpen = open === i;
          return (
            <li key={step.title} className="flex gap-3" data-testid={`plan-${i}`}>
              <span aria-hidden="true" className="w-[26px] flex flex-col items-center">
                <span className="relative w-[26px] h-[26px] shrink-0">
                  {now && <span className="absolute inset-0 rounded-full bg-accent nx-ring-once" />}
                  <span
                    className={`absolute inset-0 rounded-full border-2 grid place-items-center text-[11px] font-bold ${
                      now ? "bg-accent border-accent text-on-accent" : done ? "bg-gain border-gain text-on-accent" : "bg-surface border-line text-muted"
                    }`}
                  >
                    {done ? "✓" : i === 0 ? "•" : i}
                  </span>
                </span>
                {i < PLAN.length - 1 && <span className={`flex-1 w-0.5 my-1 ${done ? "bg-gain" : "bg-line"}`} />}
              </span>
              <span className={`flex-1 min-w-0 flex flex-col ${i < PLAN.length - 1 ? "pb-3.5" : ""}`}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="w-full min-h-[26px] flex justify-between items-center gap-2 text-left cursor-pointer"
                >
                  <span className="text-sm font-semibold">{step.title}</span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap ${
                      now ? "bg-accent-soft text-accent" : done ? "bg-gain/15 text-gain" : "bg-inset text-muted"
                    }`}
                  >
                    {chip}
                  </span>
                </button>
                {i === 0 && (
                  <span className="mt-2 flex flex-col gap-1.5" data-testid="plan-progress">
                    {progress ? (
                      <>
                        <span className="h-2 rounded-full bg-inset overflow-hidden" aria-hidden="true">
                          <span
                            className="block h-full rounded-full bg-accent nx-grow"
                            style={{ width: `${Math.min(100, (progress.day / PLAN_DAYS) * 100).toFixed(1)}%`, animationDelay: "300ms" }}
                          />
                        </span>
                        <span className="flex justify-between gap-2 text-xs text-muted tabular-nums">
                          <span>
                            Day {progress.day} of about {PLAN_DAYS}
                          </span>
                          <span>
                            {progress.ready} of {progress.rows} condition rows ready
                          </span>
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-muted">Waiting for the scanner's first setups.</span>
                    )}
                  </span>
                )}
                <span className={`nx-fold${isOpen ? " nx-fold-open" : ""}`}>
                  <span>
                    <span className="block pt-2 text-[13px] text-muted leading-relaxed">{step.text}</span>
                  </span>
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
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

/** Your trades' win rates by strategy or by the market's mood, a switch between them; the bars grow, against a 50% line. */
const WinRates: React.FC<{ breakdowns: LearningBreakdowns }> = ({ breakdowns }) => {
  const [by, setBy] = useState<"family" | "regime">("family");
  const rows = by === "family" ? breakdowns.byFamily : breakdowns.byRegime;
  const labels = by === "family" ? FAMILY : REGIME;
  return (
    <Card aria-label="Win rate, your trades" className="flex flex-col gap-3">
      <h2 className="m-0 text-sm font-semibold">Win rate, your trades</h2>
      <Segmented
        label="Group by"
        options={[
          { id: "family", label: "By strategy" },
          { id: "regime", label: "By market mood" },
        ]}
        value={by}
        onChange={setBy}
      />
      <div key={by} className="flex flex-col gap-3" data-testid="win-rates">
        {rows.map((r, i) => (
          <div key={r.key} className="flex flex-col gap-1.5 nx-step-in" style={{ animationDelay: `${i * 80}ms` }}>
            <div className="flex justify-between gap-3 text-[13px] tabular-nums">
              <span>{labels[r.key] ?? r.key}</span>
              <span>
                <strong className={r.winRatePct >= 50 ? "text-gain" : "text-loss"}>{r.winRatePct}%</strong> <span className="text-muted">of {r.trades}</span>
              </span>
            </div>
            <div className="relative h-2 rounded-full bg-inset" aria-hidden="true">
              <span
                className={`absolute inset-y-0 left-0 rounded-full nx-grow ${r.winRatePct >= 50 ? "bg-gain" : "bg-loss"}`}
                style={{ width: `${r.winRatePct}%`, animationDelay: `${i * 80}ms` }}
              />
              <span className="absolute left-1/2 -top-[3px] -bottom-[3px] border-l-[1.5px] border-dashed border-ink/45" />
            </div>
          </div>
        ))}
      </div>
      <p className="m-0 text-[11px] text-muted leading-snug">The dashed line is 50%. A strategy can win under half its trades and still pay, if its wins are bigger.</p>
    </Card>
  );
};

const QUADS = [
  { key: "goodCallGoodResult", call: "Good call", result: "good result", tone: "text-gain", note: "The setup was sound and it won. These show what to keep doing." },
  { key: "goodCallBadLuck", call: "Good call", result: "bad luck", tone: "text-ink", note: "The setup was sound and still lost. That happens; the desk doesn't learn from bad luck." },
  { key: "badCallLuckyWin", call: "Bad call", result: "lucky win", tone: "text-warn", note: "A weak setup that happened to win. The desk treats these as warnings, not wins." },
  { key: "badCallBadResult", call: "Bad call", result: "bad result", tone: "text-loss", note: "A weak setup that lost. These are the ones the desk learns from." },
] as const;

/** Each real trade by how good the call was and how it turned out; tap one for what it means. */
const Decisions: React.FC<{ d: LearningBreakdowns["decisions"] }> = ({ d }) => {
  const [picked, setPicked] = useState<(typeof QUADS)[number]["key"] | null>(null);
  const note = QUADS.find((q) => q.key === picked)?.note ?? "A good call can still lose. The desk learns from the bad calls, not the bad luck. Tap one to read it.";
  return (
    <Card aria-label="Decision vs outcome" className="flex flex-col gap-3">
      <h2 className="m-0 text-sm font-semibold">Good calls and good luck</h2>
      <div className="grid grid-cols-2 gap-2">
        {QUADS.map((q, i) => (
          <button
            key={q.key}
            type="button"
            aria-pressed={picked === q.key}
            onClick={() => setPicked(picked === q.key ? null : q.key)}
            className={`p-3 rounded-[14px] bg-inset text-left cursor-pointer nx-badge-pop transition-transform ${picked === q.key ? "ring-2 ring-accent scale-[1.03]" : ""}`}
            style={{ animationDelay: `${300 + i * 90}ms` }}
          >
            <span className={`block font-display text-[28px] leading-none tabular-nums ${q.tone}`}>{d[q.key]}</span>
            <span className="block mt-1 text-xs leading-snug">
              <strong>{q.call}</strong>
              <br />
              <span className="text-muted">{q.result}</span>
            </span>
          </button>
        ))}
      </div>
      <p key={picked ?? "none"} className="m-0 text-[13px] text-muted leading-relaxed nx-fade-in" data-testid="decision-note">
        {note}
      </p>
    </Card>
  );
};

/**
 * How often setups at each confidence score actually worked out, and the win
 * chance the scanner now uses for them: a column per score band, the band's
 * own score as a dashed outline, what worked out as the bar, what it uses now
 * as a dot. Tap a band for its numbers.
 */
export const WinChanceCalibration: React.FC<{ shadows: ShadowSignal[] }> = ({ shadows }) => {
  const cal = useMemo(() => buildCalibrator(shadows), [shadows]);
  const bands = cal.bands.filter((b) => b.samples > 0);
  const [picked, setPicked] = useState<number | null>(null);
  const top = Math.max(0.8, ...bands.map((b) => b.hi), ...bands.map((b) => b.observed ?? 0));
  const h = (v: number) => `${((v / top) * 100).toFixed(1)}%`;
  const band = picked !== null ? bands.find((b) => b.lo === picked) : undefined;
  const span = (b: { lo: number; hi: number }) => `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`;
  return (
    <Card aria-label="How accurate the win chance is" className="flex flex-col gap-3">
      <div>
        <h2 className="m-0 text-sm font-semibold">How accurate the win chance is</h2>
        <p className="m-0 mt-1 text-xs text-muted leading-relaxed">
          {cal.ready
            ? `Measured from ${cal.samples} finished setups. The scanner uses the measured chance, and takes a trade when it expects at least ${MIN_EDGE_R}R back after costs.`
            : `${cal.samples} of ${MIN_CALIBRATION_SAMPLES} setups finished. Until then the scanner uses its built-in estimate and the ${Math.round(DEFAULT_MIN_CONFIDENCE * 100)}% bar.`}
        </p>
      </div>
      {bands.length > 0 && (
        <>
          <div className="text-[11px] text-muted leading-snug">
            The dashed outline is what the score said; the bar is how often they worked out{cal.ready ? "; the dot is the chance it uses now" : ""}.
          </div>
          <div className="relative h-[170px] mt-3 flex gap-2.5 items-end border-b border-line" data-testid="calibration-columns">
            {bands.map((b, i) => {
              const enough = b.samples >= MIN_SHADOW_SAMPLE && b.observed !== null;
              const on = picked === b.lo;
              return (
                <button
                  key={b.lo}
                  type="button"
                  aria-pressed={on}
                  aria-label={`Score ${span(b)}: ${enough ? `${Math.round(b.observed! * 100)}% worked out` : "too few to say"} over ${b.samples} setups`}
                  onClick={() => setPicked(on ? null : b.lo)}
                  className="relative flex-1 h-full cursor-pointer"
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 rounded-t-lg border-[1.5px] border-b-0 border-dashed border-muted/70"
                    style={{ height: h((b.lo + b.hi) / 2) }}
                  />
                  {enough && (
                    <span
                      data-testid="calibration-bar"
                      className="absolute left-[18%] right-[18%] bottom-0 rounded-t-md bg-accent nx-rise transition-opacity"
                      style={{ height: h(b.observed!), animationDelay: `${150 + i * 90}ms`, opacity: picked === null || on ? 1 : 0.4 }}
                    />
                  )}
                  {cal.ready && (
                    <span
                      aria-hidden="true"
                      className="absolute left-1/2 w-3 h-3 -ml-1.5 -mb-1.5 rounded-full bg-ink shadow-[0_0_0_3px_var(--nx-surface)] nx-badge-pop"
                      style={{ bottom: h(b.calibrated), animationDelay: `${900 + i * 90}ms` }}
                    />
                  )}
                  <span className="absolute inset-x-0 -top-4 text-center text-[10px] font-semibold tabular-nums">
                    {enough ? `${Math.round(b.observed! * 100)}%` : "—"}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex gap-2.5 -mt-1.5 text-[11px] text-muted tabular-nums" aria-hidden="true">
            {bands.map((b) => (
              <span key={b.lo} className="flex-1 text-center">
                {span(b)}
              </span>
            ))}
          </div>
          <p key={picked ?? "none"} className="m-0 px-3 py-2.5 rounded-xl bg-inset text-[13px] leading-relaxed nx-fade-in" data-testid="calibration-note">
            {band
              ? `Scored ${span(band)}: ${band.samples} setups${
                  band.samples >= MIN_SHADOW_SAMPLE && band.observed !== null ? `, ${Math.round(band.observed * 100)}% worked out` : ", too few to say yet"
                }.${cal.ready ? ` The scanner now uses ${Math.round(band.calibrated * 100)}% for these.` : ""}`
              : "Tap a band for its numbers."}
          </p>
        </>
      )}
      <p className="m-0 text-xs text-muted leading-relaxed">
        A setup that hit its target counts as a win, a stop as a loss, and one closed at the time limit counts part-way by how far it got.
        Thin bands are pulled toward their own score until they have more setups.
      </p>
    </Card>
  );
};

/**
 * What happened to setups the scanner found: the proposed ones next to each
 * reason for skipping, each with its average result as a bar either side of
 * zero. A skip reason whose setups do as well as proposed ones is a filter
 * costing you trades, and says so.
 */
export const SkippedSetups: React.FC<{ shadows: ShadowSignal[] }> = ({ shadows }) => {
  const rows = useMemo(() => summarizeShadows(shadows), [shadows]);
  const open = shadows.filter((s) => s.status === "open").length;
  const proposed = rows.find((r) => r.kind === "proposed");
  const proposedR = proposed && proposed.resolved >= MIN_SHADOW_SAMPLE ? proposed.avgR : null;
  const most = Math.max(0.2, ...rows.filter((r) => r.resolved >= MIN_SHADOW_SAMPLE && r.avgR !== null).map((r) => Math.abs(r.avgR!)));
  return (
    <Card aria-label="What skipped setups did" className="flex flex-col gap-2.5">
      <div>
        <h2 className="m-0 text-sm font-semibold">What skipped setups did</h2>
        <p className="m-0 mt-1 text-xs text-muted leading-relaxed">
          Every setup is followed on real prices until it would have hit its target or stop (as long as a real trade would run: 4 hours for a
          coin, 30 minutes for a stock).{open > 0 && ` ${open} still being followed.`}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">Nothing tracked yet. Setups appear here as the scanner finds them.</p>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-1" aria-label="Outcome by reason">
          {rows.map((r, i) => {
            const enough = r.resolved >= MIN_SHADOW_SAMPLE;
            const isProposed = r.kind === "proposed";
            const label = isProposed ? "Proposed" : SKIP_REASON_LABEL[r.kind as SkipReason] ?? r.kind;
            const w = enough && r.avgR !== null ? Math.min(50, (Math.abs(r.avgR) / most) * 50) : 0;
            // A reason costs trades only if what it skipped made money, as much as what was proposed.
            const costing = !isProposed && enough && r.avgR !== null && proposedR !== null && r.avgR > 0 && r.avgR >= proposedR;
            return (
              <li
                key={r.kind}
                data-testid={`skip-${r.kind}`}
                className={`-mx-3 px-3 py-2.5 rounded-[14px] flex flex-col gap-1.5 nx-step-in ${isProposed ? "bg-inset" : ""}`}
                style={{ animationDelay: `${i * 70}ms` }}
              >
                <span className="flex justify-between items-baseline gap-2">
                  <span className={`text-[13px] ${isProposed ? "font-bold" : ""}`}>{label}</span>
                  <span className={`text-[13px] font-bold tabular-nums ${enough && r.avgR !== null ? (r.avgR >= 0 ? "text-gain" : "text-loss") : "text-muted"}`}>
                    {enough && r.avgR !== null ? signedR(r.avgR) : "—"}
                  </span>
                </span>
                <span className="relative h-1.5 rounded-full bg-inset" aria-hidden="true">
                  <span className="absolute left-1/2 -top-[3px] -bottom-[3px] w-px bg-muted" />
                  {w > 0 && (
                    <span
                      className={`absolute inset-y-0 rounded-full ${r.avgR! >= 0 ? "bg-gain nx-grow" : "bg-loss nx-grow-left"}`}
                      style={{ left: r.avgR! >= 0 ? "50%" : `${50 - w}%`, width: `${w}%`, animationDelay: `${150 + i * 70}ms` }}
                    />
                  )}
                </span>
                <span className="flex justify-between items-center gap-2 text-[11px] text-muted tabular-nums">
                  <span>
                    {r.resolved} of {r.tracked} finished{enough && r.targetPct !== null ? ` · ${r.targetPct}% hit the target` : ""}
                  </span>
                  {costing && <span className="shrink-0 whitespace-nowrap px-2 py-0.5 rounded-full bg-warn-soft text-warn font-bold nx-badge-pop">Costing trades?</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="m-0 text-xs text-muted leading-relaxed">
        Results are after fees; a candle that touched both stop and target counts as the stop. Numbers show once {MIN_SHADOW_SAMPLE} setups of a
        kind have finished. A reason marked “Costing trades?” skips setups that made money, as much as the ones proposed.
      </p>
    </Card>
  );
};

const LiveShadows: React.FC<{ children: (shadows: ShadowSignal[]) => React.ReactNode }> = ({ children }) => {
  const [shadows, setShadows] = useState<ShadowSignal[]>(() => shadowStore.all());
  useEffect(() => shadowStore.subscribe(() => setShadows(shadowStore.all())), []);
  return <>{children(shadows)}</>;
};

type Section = "trades" | "setups";
const SECTIONS: readonly Section[] = ["trades", "setups"];
const TAB_KEY = "nx-learning-tab";
function savedSection(): Section {
  try {
    return localStorage.getItem(TAB_KEY) === "setups" ? "setups" : "trades";
  } catch {
    return "trades";
  }
}

export const LedgerLearning: React.FC<LedgerLearningProps> = (props) => {
  const { experiences } = props;
  const stats = useMemo(() => computeLearningStats(experiences), [experiences]);
  const breakdowns = useMemo(() => computeLearningBreakdowns(experiences), [experiences]);
  const rates = useMemo(() => rollingWinRates(experiences), [experiences]);
  const [section, setSectionState] = useState<Section>(savedSection);
  const slide = useSlideFrom(section, SECTIONS);
  const setSection = (s: Section) => {
    setSectionState(s);
    try {
      localStorage.setItem(TAB_KEY, s);
    } catch {
      // Private browsing: the tab just isn't remembered.
    }
  };
  const d = breakdowns.decisions;
  const classified = d.goodCallGoodResult + d.goodCallBadLuck + d.badCallLuckyWin + d.badCallBadResult;

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
  const setups = (shadows: ShadowSignal[]) => (
    <>
      <WinChanceCalibration shadows={shadows} />
      <SkippedSetups shadows={shadows} />
    </>
  );

  return (
    <div className="font-ui text-ink flex flex-col gap-4 pb-4 select-none">
      <header className="flex items-center justify-between gap-3 pt-1 nx-fade-in">
        <h1 className="m-0 font-display text-[26px] font-semibold">Learning</h1>
        <RoundIconButton label="Export memory" onClick={exportMemory}>
          <Download className="w-[18px] h-[18px]" strokeWidth={1.6} />
        </RoundIconButton>
      </header>

      <div role="tablist" aria-label="Learning" className="relative grid grid-cols-2 p-1 rounded-full bg-surface border border-line">
        <span
          aria-hidden="true"
          data-testid="learning-tab-pill"
          className="nx-strategy-pill absolute inset-y-1 left-1 rounded-full bg-accent"
          style={{ width: "calc((100% - 8px) / 2)", transform: `translateX(${SECTIONS.indexOf(section) * 100}%)` }}
        />
        {SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={section === s}
            onClick={() => setSection(s)}
            className={`relative min-h-10 rounded-full text-[13px] font-semibold cursor-pointer transition-colors ${section === s ? "text-on-accent" : "text-muted"}`}
          >
            {s === "trades" ? "Your trades" : "Every setup"}
          </button>
        ))}
      </div>

      <div key={section} className={`flex flex-col gap-4 ${slide ?? ""}`}>
        {section === "trades" ? (
          <>
            <MemoryCard stats={stats} total={experiences.length} />
            {stats.enough && <GettingBetter stats={stats} rates={rates} />}
            <LearningPlan now={props.now} />
            {stats.enough && (breakdowns.byFamily.length > 0 || breakdowns.byRegime.length > 0) && <WinRates breakdowns={breakdowns} />}
            {stats.enough && classified > 0 && <Decisions d={d} />}
          </>
        ) : (
          <>
            {props.shadows !== undefined ? setups(props.shadows) : <LiveShadows>{setups}</LiveShadows>}
            <Card aria-label="Autopilot and model" className="flex flex-col py-1">
              <div className="flex items-center gap-3 min-h-14 py-2 border-b border-line">
                <Ring pct={autopilotWinPct ?? 0} size={40} width={5} tone="stroke-gain" testId="autopilot-ring" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold">Autopilot's record</span>
                  <span className="block text-xs text-muted tabular-nums">
                    {props.autopilotTrades === 0
                      ? "No closed trades yet"
                      : `${props.autopilotWins} of ${props.autopilotTrades} closed trades won (${autopilotWinPct}%)`}
                  </span>
                </span>
              </div>
              <button type="button" onClick={props.onOpenLab} className="w-full flex items-center gap-3 min-h-14 py-2 text-left cursor-pointer">
                <span aria-hidden="true" className="w-10 h-10 shrink-0 rounded-xl bg-accent-soft text-accent grid place-items-center">
                  <FlaskConical className="w-[18px] h-[18px]" strokeWidth={1.7} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold">Model in use</span>
                  <span className="block text-xs text-muted mt-0.5 truncate">
                    {lab ? `Lab model · ${lab.datasetName} · ${lab.winRatePct.toFixed(0)}% win rate in testing` : "Live learning only · no Lab model promoted"}
                  </span>
                </span>
                <ChevronRight className="w-4 h-4 text-muted shrink-0" />
              </button>
            </Card>
          </>
        )}
      </div>
    </div>
  );
};
