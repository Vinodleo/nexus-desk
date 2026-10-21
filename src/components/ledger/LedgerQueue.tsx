import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { TradeProposal } from "../../types";
import { DataQualityNotice } from "../DataQualityNotice";
import { RoundIconButton, SectionHeading, Switch } from "./ui";
import { formatMoney, formatPrice } from "./format";
import { SwipeCard } from "./SwipeCard";
import { istClock, untilText, useNow } from "./FloorDesk";
import { heartbeatView } from "./ScanHeartbeat";
import { BEAT_SLOTS, type ScanBeat } from "../../shared/scanHeartbeat";
import { marketOf, type MarketKey } from "../../shared/marketLimits";
import { deskDay } from "../../shared/deskDay";
import { isNseOpen } from "../../shared/nse";
import { isUsOpen } from "../../shared/usMarket";

/** How far each card in the deck peeks out under the one above it. */
const DECK_STEP_PX = 8;

/** How long a swiped proposal waits, with Undo, before it's approved or skipped. */
export const UNDO_MS = 5000;

type PendingSwipe = { proposal: TradeProposal; action: "approve" | "skip"; seq: number };

export interface LedgerQueueProps {
  proposals: TradeProposal[];
  onApprove: (proposal: TradeProposal) => void;
  onReject: (proposalId: string, reason: string) => void;
  /** Offered while autopilot is on, to approve everything waiting at once. */
  onApproveAll?: () => void;
  onScan: () => void;
  isScanning: boolean;
  continuousScan: boolean;
  onContinuousScanChange: (on: boolean) => void;
  autopilotOn: boolean;
  memoryCount: number;
  /** Live mode sends approved trades to CoinDCX. */
  isLive?: boolean;
  /** The server's last scan and its scans over the last hour (the Floor's heartbeat), for the quiet Queue. */
  lastServerScanAt?: number;
  serverScans?: ScanBeat[];
  /** Fixed time, for tests. */
  now?: number;
}

const FAMILY_LABEL: Record<string, string> = {
  trend_following: "Trend following",
  breakout_confirmation: "Breakout",
  mean_reversion: "Mean reversion",
  volatility_filter: "Volatility",
  event_news_filter: "News",
};

const MARKET_NAME: Record<MarketKey, string> = { coins: "Coins", stocks: "Indian stocks", us: "US stocks" };

function timeframeLabel(tf: string): string {
  const m = /^(\d+)([mhd])$/.exec(tf);
  if (!m) return tf;
  return `${m[1]} ${m[2] === "m" ? "min" : m[2] === "h" ? "h" : "d"}`;
}

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** "+2R", "+1.5R": a target's distance in multiples of what the stop risks. */
const targetR = (r: number) => `+${Number(r.toFixed(1))}R`;

/** The numbers a proposal card shows, derived from the proposal. */
export function describeProposal(p: TradeProposal, now = Date.now()) {
  const { setup, evAssessment: ev, riskCalc, metaScore } = p;
  const units = riskCalc.recommendedPositionSizeUnits || 0;
  const riskPerUnit = Math.abs(setup.entryPrice - setup.stopLoss);
  const rewardPerUnit = Math.abs(setup.takeProfit - setup.entryPrice);
  const votes = p.personaVotesCast ?? 0;
  const ageMin = Math.max(0, Math.round((now - new Date(p.timestamp).getTime()) / 60000));
  const family = FAMILY_LABEL[setup.family] ?? titleCase(setup.family);
  const similar = metaScore.historicalSampleCount > 0;
  return {
    action: `${setup.direction === "LONG" ? "Buy" : "Sell"} ${p.symbol}`,
    setupLabel: `${family} · ${timeframeLabel(setup.timeframe)}`,
    /** The trader who found it (the setup's name), and its candles. */
    trader: `${setup.name || family} · ${timeframeLabel(setup.timeframe)}`,
    market: MARKET_NAME[marketOf(p.symbol)],
    winPct: Math.round(metaScore.calibratedWinProbability * 100),
    // The EV is computed for a standard risk unit, so dividing by that unit's
    // loss gives it in R (multiples of what the stop risks).
    evR: ev.avgLossDollars > 0 ? ev.expectedNetValue / ev.avgLossDollars : 0,
    sizeInr: riskCalc.recommendedDollarExposure || setup.entryPrice * units,
    riskInr: riskPerUnit * units,
    rewardInr: rewardPerUnit * units,
    /** The stop's share of the stop-to-target span (the bar's red part), or null without a target. */
    stopShare: riskPerUnit > 0 && rewardPerUnit > 0 ? riskPerUnit / (riskPerUnit + rewardPerUnit) : null,
    targetR: riskPerUnit > 0 && rewardPerUnit > 0 ? targetR(rewardPerUnit / riskPerUnit) : null,
    agreement: votes > 0 ? `${p.supportingPersonas?.length ?? 0} of ${votes} traders agree` : null,
    similar: similar ? `Similar setups won ${Math.round(metaScore.historicalWinRate * 100)}% of ${metaScore.historicalSampleCount}` : null,
    record: p.exitEdge && p.exitEdge.trades > 0 ? `its record ${signedR(p.exitEdge.r)} over ${p.exitEdge.trades}` : null,
    held: p.status === "DEFERRED" ? p.deferralReason || "Held for your review" : null,
    age: ageMin < 1 ? "just now" : ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)} h ago`,
  };
}

function signedR(r: number): string {
  return `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;
}

/** "expires in 3:12" (under an hour), "expires in 2 h", or "expiring" once due. */
export function expiryText(expiresAt: number, now: number): string {
  const s = Math.round((expiresAt - now) / 1000);
  if (s <= 0) return "expiring";
  if (s < 3600) return `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `expires in ${Math.round(s / 3600)} h`;
}

const RING_R = 31;
const RING_C = 2 * Math.PI * RING_R;

/** The chance of a win as a ring that sweeps round when the card shows. */
const WinRing: React.FC<{ pct: number }> = ({ pct }) => {
  const f = Math.max(0, Math.min(100, pct)) / 100;
  return (
    <div className="relative w-[76px] h-[76px] shrink-0" role="img" aria-label={`${pct}% chance of a win`}>
      <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true" className="-rotate-90">
        <circle cx="38" cy="38" r={RING_R} fill="none" className="stroke-inset" strokeWidth="7" />
        <circle
          data-testid="win-ring"
          cx="38"
          cy="38"
          r={RING_R}
          fill="none"
          className="stroke-gain nx-ring-sweep"
          strokeWidth="7"
          strokeLinecap="round"
          style={
            {
              "--nx-c": RING_C.toFixed(1),
              strokeDasharray: RING_C.toFixed(1),
              strokeDashoffset: (RING_C * (1 - f)).toFixed(1),
            } as React.CSSProperties
          }
        />
      </svg>
      <span aria-hidden="true" className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-[22px] leading-none font-semibold text-gain tabular-nums">{pct}%</span>
        <span className="text-[10px] text-muted mt-0.5">to win</span>
      </span>
    </div>
  );
};

/** A small ring for the proposals further down. */
const MiniRing: React.FC<{ pct: number }> = ({ pct }) => {
  const c = 2 * Math.PI * 11;
  const f = Math.max(0, Math.min(100, pct)) / 100;
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" className="-rotate-90 shrink-0">
      <circle cx="14" cy="14" r="11" fill="none" className="stroke-inset" strokeWidth="4" />
      <circle cx="14" cy="14" r="11" fill="none" className="stroke-gain" strokeWidth="4" strokeDasharray={`${(c * f).toFixed(1)} ${c.toFixed(1)}`} />
    </svg>
  );
};

const AVATAR_TONES = ["bg-accent", "bg-gain", "bg-warn"];

/** The traders backing it, as overlapping initials (three at most, then "+2"). */
const Backers: React.FC<{ names: string[] }> = ({ names }) => {
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  return (
    <span aria-hidden="true" className="flex shrink-0">
      {shown.map((n, i) => (
        <span
          key={`${n}-${i}`}
          className={`w-6 h-6 rounded-full border-2 border-surface text-on-accent text-[11px] font-bold flex items-center justify-center ${AVATAR_TONES[i % AVATAR_TONES.length]} ${i > 0 ? "-ml-2" : ""}`}
        >
          {(n.trim()[0] || "?").toUpperCase()}
        </span>
      ))}
      {more > 0 && (
        <span className="w-6 h-6 -ml-2 rounded-full border-2 border-surface bg-inset text-muted text-[10px] font-bold flex items-center justify-center">
          +{more}
        </span>
      )}
    </span>
  );
};

/** The time left to approve it: a line along the card's top running down, and the minutes and seconds. */
const Expiry: React.FC<{ proposal: TradeProposal; now?: number }> = ({ proposal, now: fixed }) => {
  const now = useNow(1000, fixed);
  const at = proposal.expiresAt;
  if (at === undefined) return null;
  return (
    <span className="shrink-0 text-xs text-muted tabular-nums" data-testid="expiry">
      {expiryText(at, now)}
    </span>
  );
};

const ExpiryBar: React.FC<{ proposal: TradeProposal; now?: number }> = ({ proposal, now: fixed }) => {
  const at = proposal.expiresAt;
  if (at === undefined) return null;
  const total = Math.max(1, proposal.approvalExpiryMs || at - new Date(proposal.timestamp).getTime());
  const elapsed = Math.max(0, total - (at - (fixed ?? Date.now())));
  return (
    <div aria-hidden="true" className="h-[3px] bg-inset">
      <div
        data-testid="expiry-bar"
        className="h-full bg-accent nx-countdown"
        style={{ animationDuration: `${total}ms`, animationDelay: `-${Math.min(elapsed, total)}ms` }}
      />
    </div>
  );
};

const ProposalCard: React.FC<{
  proposal: TradeProposal;
  busy: boolean;
  isLive: boolean;
  onApprove: () => void;
  onSkip: () => void;
  now?: number;
}> = ({ proposal, busy, isLive, onApprove, onSkip, now }) => {
  const d = describeProposal(proposal);
  const { setup } = proposal;
  const why = [d.similar, d.record].filter(Boolean).join(" · ");
  return (
    <article
      aria-label={d.action}
      className="bg-surface border border-line rounded-[22px] overflow-hidden shadow-[0_10px_28px_-18px_color-mix(in_srgb,var(--nx-scrim)_45%,transparent)]"
    >
      <ExpiryBar proposal={proposal} now={now} />
      <div className="p-[18px] pt-4 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2.5">
          <span className="min-w-0 truncate px-2.5 py-1 rounded-full bg-accent-soft text-accent text-xs font-semibold">{d.trader}</span>
          {proposal.expiresAt !== undefined ? <Expiry proposal={proposal} now={now} /> : <span className="shrink-0 text-xs text-muted">{d.age}</span>}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="m-0 font-display text-[30px] font-semibold leading-[1.05] break-words">{d.action}</h2>
            <div className="text-[13px] text-muted mt-1 tabular-nums">
              {formatPrice(setup.entryPrice)} · {d.market}
            </div>
          </div>
          <WinRing pct={d.winPct} />
        </div>

        {d.stopShare !== null && (
          <section aria-label="Stop, entry and target" className="flex flex-col gap-2">
            <div className="flex h-2.5 rounded-full overflow-hidden" aria-hidden="true">
              <div className="bg-loss/25 border-r-2 border-ink" style={{ width: `${(d.stopShare * 100).toFixed(1)}%` }} />
              <div className="flex-1 bg-gain/25" />
            </div>
            <div className="grid grid-cols-3 text-xs tabular-nums">
              <div>
                <div className="text-loss font-semibold">Stop −1R</div>
                <div className="text-muted">{formatPrice(setup.stopLoss)}</div>
              </div>
              <div className="text-center">
                <div className="font-semibold">{setup.direction === "LONG" ? "Buy" : "Sell"}</div>
                <div className="text-muted">{formatPrice(setup.entryPrice)}</div>
              </div>
              <div className="text-right">
                <div className="text-gain font-semibold">Target {d.targetR}</div>
                <div className="text-muted">{formatPrice(setup.takeProfit)}</div>
              </div>
            </div>
          </section>
        )}

        <div className="grid grid-cols-3 gap-2">
          <div className="bg-inset rounded-[14px] px-3 py-2.5 min-w-0">
            <div className="text-[11px] text-muted">Size</div>
            <div className="text-[15px] font-semibold tabular-nums truncate">{formatMoney(d.sizeInr, { decimals: 0 })}</div>
          </div>
          <div className="bg-inset rounded-[14px] px-3 py-2.5 min-w-0">
            <div className="text-[11px] text-muted">Could lose</div>
            <div className="text-[15px] font-semibold tabular-nums text-loss truncate">{formatMoney(d.riskInr, { decimals: 0 })}</div>
          </div>
          <div className="bg-inset rounded-[14px] px-3 py-2.5 min-w-0">
            <div className="text-[11px] text-muted">Expected</div>
            <div className={`text-[15px] font-semibold tabular-nums ${d.evR < 0 ? "text-loss" : "text-gain"}`}>{signedR(d.evR)}</div>
          </div>
        </div>

        {(d.agreement || why) && (
          <div className="flex flex-col gap-2 text-[13px] leading-snug">
            {d.agreement && (
              <div className="flex items-center gap-2.5">
                <Backers names={proposal.supportingPersonas ?? []} />
                <span>{d.agreement}</span>
              </div>
            )}
            {why && <div className="text-muted">{why.charAt(0).toUpperCase() + why.slice(1)}</div>}
          </div>
        )}

        {d.held && (
          <div className="text-xs leading-relaxed text-warn-ink bg-warn-soft rounded-xl px-3 py-2.5">
            <strong>Held by autopilot:</strong> {d.held}
          </div>
        )}

        <DataQualityNotice quality={proposal.dataQuality} />

        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            className="flex-1 min-h-[50px] rounded-full border border-line bg-surface text-ink font-semibold text-[15px] cursor-pointer disabled:opacity-60"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            className="flex-[2] min-h-[50px] rounded-full bg-accent text-on-accent font-semibold text-[15px] cursor-pointer disabled:opacity-60"
          >
            {busy ? "Approving…" : isLive ? "Approve live trade" : "Approve paper trade"}
          </button>
        </div>
      </div>
    </article>
  );
};

const Chip: React.FC<{ on?: boolean; children: React.ReactNode }> = ({ on, children }) => (
  <span
    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-semibold ${
      on ? "bg-gain/15 text-gain" : "bg-inset text-muted"
    }`}
  >
    <span aria-hidden="true" className={`w-[7px] h-[7px] rounded-full ${on ? "bg-gain" : "bg-muted"}`} />
    {children}
  </span>
);

/**
 * Nothing waiting: the scanner as a radar (its beam sweeps round, faster
 * while a scan runs), the next scan's countdown, which markets are open and
 * when the coins' daily check runs, and the server's last hour of scans.
 */
const QuietQueue: React.FC<{
  isScanning: boolean;
  continuousScan: boolean;
  lastScanAt: number;
  scans: ScanBeat[];
  now?: number;
}> = ({ isScanning, continuousScan, lastScanAt, scans, now: fixed }) => {
  const now = useNow(1000, fixed);
  const view = heartbeatView(scans, lastScanAt, now);
  const serverScans = lastScanAt > 0 || scans.length > 0;
  // The candle's scan is due only where something scans: the server, or this phone when it's asked to.
  const running = isScanning || (serverScans && view.scanning);
  const looking = serverScans || continuousScan;
  const ran = view.slots.filter((s) => s.beat).length;
  const latest = [...view.slots].reverse().find((s) => s.beat)?.beat;
  const proposed = view.slots.reduce((a, s) => a + (s.beat?.proposed ?? 0), 0);
  const coinCheck = deskDay(now).events.find((e) => e.id === "coin-check");
  const coinAt = coinCheck ? istClock(coinCheck.nextAt) : null;

  return (
    <div className="flex flex-col gap-3">
      <section aria-label="The scanner" className="bg-surface border border-line rounded-[22px] px-[18px] py-5 flex flex-col items-center gap-4">
        <div className="relative w-[200px] h-[200px]" aria-hidden="true" data-testid="radar">
          <svg width="200" height="200" viewBox="0 0 200 200" className="absolute inset-0">
            <circle cx="100" cy="100" r="96" fill="none" className="stroke-line" strokeWidth="1" />
            <circle cx="100" cy="100" r="64" fill="none" className="stroke-line" strokeWidth="1" />
            <circle cx="100" cy="100" r="32" fill="none" className="stroke-line" strokeWidth="1" />
            <line x1="100" y1="4" x2="100" y2="196" className="stroke-line" strokeWidth="1" />
            <line x1="4" y1="100" x2="196" y2="100" className="stroke-line" strokeWidth="1" />
            <circle cx="146" cy="62" r="4.5" className={proposed > 0 ? "fill-gain" : "fill-muted"} opacity={proposed > 0 ? 1 : 0.45} />
            <circle cx="58" cy="138" r="3.5" className="fill-muted" opacity="0.45" />
            <circle cx="128" cy="154" r="3.5" className="fill-muted" opacity="0.45" />
          </svg>
          {looking && (
            <svg width="200" height="200" viewBox="0 0 200 200" className={`absolute inset-0 nx-radar${running ? " nx-radar-fast" : ""}`}>
              <path d="M100 100 L100 4 A96 96 0 0 1 183 52 Z" className="fill-accent" opacity="0.12" />
              <line x1="100" y1="100" x2="100" y2="4" className="stroke-accent" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
          <span className="absolute left-1/2 top-1/2 w-3 h-3 -ml-1.5 -mt-1.5 rounded-full bg-accent" />
        </div>
        <div className="text-center">
          <h2 className="m-0 font-display text-xl font-semibold">{running ? "Scanning the markets…" : "Nothing to approve"}</h2>
          <div className="text-[13px] text-muted mt-1 tabular-nums">
            {running ? "Each 5-minute candle is checked as it closes" : looking ? `Next scan ${untilText(view.next, now)}` : "Scanning is off on this phone"}
          </div>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Chip on={isUsOpen(now)}>{isUsOpen(now) ? "US open" : "US closed"}</Chip>
          <Chip on={isNseOpen(now)}>{isNseOpen(now) ? "India open" : "India closed"}</Chip>
          {coinAt && (
            <Chip>
              Coins: daily check {coinAt.time} {coinAt.half}
            </Chip>
          )}
        </div>
      </section>

      {serverScans && (
        <section aria-label="The last hour" className="grid grid-cols-3 gap-2">
          <div className="bg-surface border border-line rounded-2xl p-3">
            <div className="font-display text-2xl tabular-nums">
              {ran}
              <span className="text-sm text-muted"> of {BEAT_SLOTS}</span>
            </div>
            <div className="text-[11px] text-muted mt-0.5 leading-tight">scans this hour</div>
          </div>
          <div className="bg-surface border border-line rounded-2xl p-3">
            <div className="font-display text-2xl tabular-nums">{latest?.checked ?? 0}</div>
            <div className="text-[11px] text-muted mt-0.5 leading-tight">checked each scan</div>
          </div>
          <div className="bg-surface border border-line rounded-2xl p-3">
            <div className="font-display text-2xl tabular-nums">{proposed}</div>
            <div className="text-[11px] text-muted mt-0.5 leading-tight">proposed this hour</div>
          </div>
        </section>
      )}

      <p className="m-0 text-[13px] leading-relaxed text-muted px-1">
        Only setups with a good chance of winning and a positive expected value after fees reach this queue.
        {serverScans
          ? " The server scans for you; trades that pass its checks open by themselves."
          : continuousScan
            ? " The scanner keeps looking."
            : " Scanning is paused; tap the refresh button to scan once."}
      </p>
    </div>
  );
};

/** "Approving Buy SOL/INR · Undo", with a bar running down to when it goes through. */
const UndoBar: React.FC<{ pending: PendingSwipe; onUndo: () => void }> = ({ pending, onUndo }) => {
  const action = describeProposal(pending.proposal).action;
  return (
    <div className="fixed inset-x-0 bottom-24 z-40 flex justify-center px-4 pointer-events-none">
      <div
        role="status"
        className="nx-snack-in pointer-events-auto relative overflow-hidden w-full max-w-sm flex items-center justify-between gap-3 pl-4 pr-2 py-2 rounded-2xl bg-ink text-canvas shadow-lg"
      >
        <span className="min-w-0 text-[13px] truncate">
          {pending.action === "approve" ? "Approving" : "Skipping"} <strong>{action}</strong>
        </span>
        <button
          type="button"
          onClick={onUndo}
          className="shrink-0 min-h-9 px-3.5 rounded-full text-[13px] font-semibold text-accent-soft hover:bg-canvas/10 cursor-pointer"
        >
          Undo
        </button>
        <span
          aria-hidden="true"
          className="absolute left-0 bottom-0 h-[2px] w-full bg-canvas/50 nx-countdown"
          style={{ animationDuration: `${UNDO_MS}ms` }}
        />
      </div>
    </div>
  );
};

export const LedgerQueue: React.FC<LedgerQueueProps> = (props) => {
  // Highest chance of a win first; expected value breaks ties.
  const waiting = useMemo(
    () =>
      props.proposals
        .filter((p) => p.status === "PENDING_APPROVAL" || p.status === "DEFERRED")
        .sort(
          (a, b) =>
            b.metaScore.calibratedWinProbability - a.metaScore.calibratedWinProbability ||
            b.evAssessment.expectedNetValue - a.evAssessment.expectedNetValue
        ),
    [props.proposals]
  );
  const recentlyApproved = useMemo(
    () => props.proposals.filter((p) => p.status === "APPROVED" || p.status === "AUTO_EXECUTED").slice(0, 5),
    [props.proposals]
  );

  const [pending, setPending] = useState<PendingSwipe | null>(null);
  const [returnedId, setReturnedId] = useState<string | null>(null);
  const pendingRef = useRef<PendingSwipe | null>(null);
  pendingRef.current = pending;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const shown = waiting.filter((p) => p.id !== pending?.proposal.id);
  const focused = shown.find((p) => p.id === focusedId) ?? shown[0];
  const others = shown.filter((p) => p !== focused);
  const heldCount = shown.filter((p) => p.status === "DEFERRED").length;
  // The deck: up to two of the others peek out under the card on top.
  const peeks = Math.min(2, others.length);
  // When the card on top has gone (swiped, approved or skipped), the next
  // rises from the deck into its place; picking one from the list, or Undo
  // (which pops it back in), doesn't.
  const lastTop = useRef<{ id: string | null; rise: boolean }>({ id: focused?.id ?? null, rise: false });
  if (focused && lastTop.current.id !== focused.id) {
    const prev = lastTop.current.id;
    lastTop.current = { id: focused.id, rise: prev !== null && !shown.some((p) => p.id === prev) };
  }
  const rising = Boolean(focused) && lastTop.current.rise;
  const readyCount = shown.length - heldCount;

  // Once a proposal leaves the queue, forget that it was being approved.
  useEffect(() => {
    if (busyId && !waiting.some((p) => p.id === busyId)) setBusyId(null);
  }, [busyId, waiting]);

  // A swipe waits UNDO_MS behind an Undo bar before it counts. Leaving the
  // Queue, or swiping another card, lets the waiting one go through at once.
  const latest = useRef(props);
  latest.current = props;
  const seq = useRef(0);

  const carryOut = useCallback((sw: PendingSwipe) => {
    const { proposals, onApprove, onReject } = latest.current;
    // Only if it's still waiting: it may have expired or been handled meanwhile.
    const now = proposals.find((p) => p.id === sw.proposal.id && (p.status === "PENDING_APPROVAL" || p.status === "DEFERRED"));
    if (!now) return;
    if (sw.action === "approve") onApprove(now);
    else onReject(now.id, "Skipped by you in the queue");
  }, []);

  const swiped = (proposal: TradeProposal, action: PendingSwipe["action"]) => {
    if (pendingRef.current) carryOut(pendingRef.current);
    const next = { proposal, action, seq: ++seq.current };
    pendingRef.current = next;
    setPending(next);
    setFocusedId(null);
  };

  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => {
      if (pendingRef.current?.seq !== pending.seq) return;
      pendingRef.current = null;
      setPending(null);
      carryOut(pending);
    }, UNDO_MS);
    return () => clearTimeout(t);
  }, [pending, carryOut]);

  useEffect(
    () => () => {
      if (pendingRef.current) carryOut(pendingRef.current);
    },
    [carryOut]
  );

  const undo = () => {
    const sw = pendingRef.current;
    if (!sw) return;
    pendingRef.current = null;
    setPending(null);
    setFocusedId(sw.proposal.id);
    setReturnedId(sw.proposal.id);
  };

  const subtitle =
    shown.length === 0
      ? "Nothing waiting for you"
      : `${shown.length} waiting${heldCount > 0 ? ` · ${heldCount} held by autopilot` : ""}`;

  return (
    <div className="font-ui text-ink flex flex-col gap-4 pb-4 select-none">
      <header className="flex items-center justify-between gap-3 pt-1">
        <div className="min-w-0">
          <h1 className="m-0 font-display text-[26px] font-semibold">Proposals</h1>
          <div className="text-[13px] text-muted">{subtitle}</div>
        </div>
        <RoundIconButton label={props.isScanning ? "Scanning markets" : "Scan markets now"} onClick={props.isScanning ? undefined : props.onScan}>
          <RefreshCw className={`w-[18px] h-[18px] ${props.isScanning ? "animate-spin" : ""}`} strokeWidth={1.6} />
        </RoundIconButton>
      </header>

      {props.autopilotOn && (
        <div className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-accent-soft text-accent text-[13px] leading-snug">
          <span>
            {props.isLive
              ? "Live mode: the server's autopilot places real CoinDCX orders within your limits (when the server allows live orders). The ones here need you."
              : "Autopilot is on. Trades that pass every check open by themselves; the ones here need you."}
          </span>
          {props.onApproveAll && readyCount > 1 && (
            <button type="button" onClick={props.onApproveAll} className="shrink-0 font-semibold underline cursor-pointer">
              Approve all {readyCount}
            </button>
          )}
        </div>
      )}

      {focused ? (
        <div className="flex flex-col gap-2">
          <div className="relative" style={{ paddingBottom: peeks * DECK_STEP_PX }}>
            {/* The next proposals, peeking out under the card like a deck (the lowest first, so it sits behind). */}
            {Array.from({ length: peeks }, (_, k) => peeks - k).map((depth) => (
              <div
                key={depth}
                aria-hidden="true"
                data-testid="deck-peek"
                className="absolute inset-x-0 top-0 rounded-[22px] border border-line bg-surface origin-bottom nx-deck-peek"
                style={{
                  bottom: peeks * DECK_STEP_PX,
                  transform: `translateY(${depth * DECK_STEP_PX}px) scale(${1 - depth * 0.04})`,
                  opacity: depth === 1 ? 1 : 0.7,
                }}
              />
            ))}
            <div
              key={focused.id}
              data-testid="deck-top"
              className={`relative origin-bottom${returnedId === focused.id ? " nx-pop-in" : rising ? " nx-deck-rise" : ""}`}
            >
              {/* Swipe right to approve (paper only: live orders need the button), left to skip. */}
              <SwipeCard
                onSwipeRight={props.isLive ? undefined : () => swiped(focused, "approve")}
                onSwipeLeft={() => swiped(focused, "skip")}
                rightLabel="Approve"
                leftLabel="Skip"
                disabled={busyId === focused.id}
              >
                <ProposalCard
                  proposal={focused}
                  busy={busyId === focused.id}
                  isLive={Boolean(props.isLive)}
                  onApprove={() => {
                    setBusyId(focused.id);
                    props.onApprove(focused);
                  }}
                  onSkip={() => props.onReject(focused.id, "Skipped by you in the queue")}
                  now={props.now}
                />
              </SwipeCard>
            </div>
          </div>
          <div className="text-center text-[11px] text-muted">
            {props.isLive ? "Swipe left to skip · live trades are approved with the button" : "Swipe right to approve · left to skip"}
          </div>
        </div>
      ) : (
        <QuietQueue
          isScanning={props.isScanning}
          continuousScan={props.continuousScan}
          lastScanAt={props.lastServerScanAt ?? 0}
          scans={props.serverScans ?? []}
          now={props.now}
        />
      )}

      {others.length > 0 && (
        <section className="flex flex-col">
          <SectionHeading title="Next in line" />
          <ul className="list-none m-0 p-0 flex flex-col" aria-label="Other proposals">
            {others.map((p) => {
              const d = describeProposal(p);
              return (
                <li key={p.id} className="border-b border-line">
                  <button
                    type="button"
                    onClick={() => setFocusedId(p.id)}
                    className="w-full min-h-[52px] flex items-center justify-between gap-3 py-2.5 px-1 text-left cursor-pointer"
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold">{d.action}</span>
                      <span className={`block text-xs truncate ${d.held ? "text-warn" : "text-muted"}`}>
                        {d.held ? `Held · ${d.held}` : d.trader}
                        {!d.held && p.expiresAt !== undefined && (
                          <>
                            {" · "}
                            <Expiry proposal={p} now={props.now} />
                          </>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 flex items-center gap-2">
                      <MiniRing pct={d.winPct} />
                      <span className="font-display text-lg tabular-nums">{d.winPct}%</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {pending && <UndoBar key={pending.seq} pending={pending} onUndo={undo} />}

      {recentlyApproved.length > 0 && (
        <section aria-label="Recently approved" className="flex flex-col">
          <SectionHeading title="Recently approved" />
          <ul className="list-none m-0 p-0">
            {recentlyApproved.map((p) => {
              const d = describeProposal(p);
              return (
                <li key={p.id} className="flex items-center justify-between gap-3 py-3 border-b border-line text-sm">
                  <span className="min-w-0">
                    <span className="font-semibold">{d.action}</span>{" "}
                    <span className="text-xs text-muted">{d.age}</span>
                  </span>
                  <span className="shrink-0 text-muted tabular-nums">{d.winPct}%</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="bg-surface border border-line rounded-2xl px-3.5">
        <div className="flex items-center justify-between gap-3 min-h-12 py-2 border-b border-line text-sm">
          <div>
            <div>Keep scanning</div>
            <div className="text-xs text-muted mt-0.5">Checks the markets every cycle for new setups</div>
          </div>
          <Switch checked={props.continuousScan} onChange={props.onContinuousScanChange} label="Keep scanning" />
        </div>
        <div className="flex items-center justify-between gap-3 min-h-12 py-2 text-sm">
          <span>Memory</span>
          <span className="text-muted tabular-nums">{props.memoryCount.toLocaleString("en-IN")} past examples</span>
        </div>
      </section>
    </div>
  );
};
