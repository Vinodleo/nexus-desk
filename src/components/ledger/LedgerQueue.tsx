import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Clock, ChevronRight } from "lucide-react";
import type { TradeProposal } from "../../types";
import { DataQualityNotice } from "../DataQualityNotice";
import { RoundIconButton, SectionHeading, StatTile, Switch } from "./ui";
import { formatMoney, formatPrice } from "./format";
import { SwipeCard } from "./SwipeCard";

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
}

const FAMILY_LABEL: Record<string, string> = {
  trend_following: "Trend following",
  breakout_confirmation: "Breakout",
  mean_reversion: "Mean reversion",
  volatility_filter: "Volatility",
  event_news_filter: "News",
};

function timeframeLabel(tf: string): string {
  const m = /^(\d+)([mhd])$/.exec(tf);
  if (!m) return tf;
  return `${m[1]} ${m[2] === "m" ? "min" : m[2] === "h" ? "h" : "d"}`;
}

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** The numbers a proposal card shows, derived from the proposal. */
export function describeProposal(p: TradeProposal, now = Date.now()) {
  const { setup, evAssessment: ev, riskCalc, metaScore } = p;
  const units = riskCalc.recommendedPositionSizeUnits || 0;
  const riskPerUnit = Math.abs(setup.entryPrice - setup.stopLoss);
  const rewardPerUnit = Math.abs(setup.takeProfit - setup.entryPrice);
  const votes = p.personaVotesCast ?? 0;
  const ageMin = Math.max(0, Math.round((now - new Date(p.timestamp).getTime()) / 60000));
  return {
    action: `${setup.direction === "LONG" ? "Buy" : "Sell"} ${p.symbol}`,
    setupLabel: `${FAMILY_LABEL[setup.family] ?? titleCase(setup.family)} · ${timeframeLabel(setup.timeframe)}`,
    winPct: Math.round(metaScore.calibratedWinProbability * 100),
    // The EV is computed for a standard risk unit, so dividing by that unit's
    // loss gives it in R (multiples of what the stop risks).
    evR: ev.avgLossDollars > 0 ? ev.expectedNetValue / ev.avgLossDollars : 0,
    sizeInr: riskCalc.recommendedDollarExposure || setup.entryPrice * units,
    riskInr: riskPerUnit * units,
    rewardInr: rewardPerUnit * units,
    agreement: votes > 0 ? `${p.supportingPersonas?.length ?? 0} of ${votes} analysts agree` : null,
    held: p.status === "DEFERRED" ? p.deferralReason || "Held for your review" : null,
    age: ageMin < 1 ? "just now" : ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)} h ago`,
  };
}

function signedR(r: number): string {
  return `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;
}

const ProposalCard: React.FC<{
  proposal: TradeProposal;
  busy: boolean;
  isLive: boolean;
  onApprove: () => void;
  onSkip: () => void;
}> = ({ proposal, busy, isLive, onApprove, onSkip }) => {
  const d = describeProposal(proposal);
  return (
    <article
      aria-label={d.action}
      className="bg-surface border border-line rounded-[18px] p-[18px] flex flex-col gap-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted">{d.setupLabel}</div>
          <h2 className="m-0 font-display text-[28px] font-semibold leading-tight">{d.action}</h2>
        </div>
        <div className="shrink-0 flex items-center gap-1 text-xs text-muted tabular-nums">
          <Clock className="w-3.5 h-3.5" strokeWidth={1.8} />
          {d.age}
        </div>
      </div>

      <div className="flex items-end gap-6">
        <div>
          <div className="font-display text-[52px] leading-none text-gain tabular-nums">
            {d.winPct}
            <span className="text-2xl">%</span>
          </div>
          <div className="text-xs text-muted mt-1">chance of a win</div>
        </div>
        <div>
          <div className={`font-display text-[30px] leading-none tabular-nums ${d.evR < 0 ? "text-loss" : ""}`}>{signedR(d.evR)}</div>
          <div className="text-xs text-muted mt-1">expected, after fees</div>
        </div>
      </div>

      <div className="flex gap-2.5">
        <StatTile label="Size" value={formatMoney(d.sizeInr, { decimals: 0 })} valueClassName="font-ui text-sm font-semibold" />
        <StatTile label="Stop" value={formatPrice(proposal.setup.stopLoss)} valueClassName="font-ui text-sm font-semibold text-loss" />
        <StatTile label="Target" value={formatPrice(proposal.setup.takeProfit)} valueClassName="font-ui text-sm font-semibold text-gain" />
      </div>

      <p className="m-0 text-[13px] leading-relaxed text-muted">
        {d.agreement && `${d.agreement}. `}
        Risking {formatMoney(d.riskInr, { decimals: 0 })} to make about {formatMoney(d.rewardInr, { decimals: 0 })}.
      </p>

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
    </article>
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
              ? "Live mode: autopilot places no real orders. Each trade here opens on CoinDCX only when you approve it."
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
        <div key={focused.id} className={`flex flex-col gap-2${returnedId === focused.id ? " nx-pop-in" : ""}`}>
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
            />
          </SwipeCard>
          <div className="text-center text-[11px] text-muted">
            {props.isLive ? "Swipe left to skip · live trades are approved with the button" : "Swipe right to approve · left to skip"}
          </div>
        </div>
      ) : (
        <section className="bg-surface border border-line rounded-[18px] p-[18px] flex flex-col gap-2">
          <h2 className="m-0 font-display text-xl font-semibold">
            {props.isScanning ? "Scanning the markets…" : "Nothing to approve"}
          </h2>
          <p className="m-0 text-[13px] leading-relaxed text-muted">
            Only setups with a good chance of winning and a positive expected value after fees reach this queue.
            {props.continuousScan ? " The scanner keeps looking." : " Scanning is paused; tap the refresh button to scan once."}
          </p>
        </section>
      )}

      {others.length > 0 && (
        <ul className="list-none m-0 p-0 flex flex-col" aria-label="Other proposals">
          {others.map((p) => {
            const d = describeProposal(p);
            return (
              <li key={p.id} className="border-b border-line">
                <button
                  type="button"
                  onClick={() => setFocusedId(p.id)}
                  className="w-full flex items-center justify-between gap-3 py-3 px-1 text-left cursor-pointer"
                >
                  <span className="min-w-0">
                    <span className="block font-semibold">{d.action}</span>
                    <span className={`block text-xs truncate ${d.held ? "text-warn" : "text-muted"}`}>
                      {d.held ? `Held · ${d.held}` : d.setupLabel}
                    </span>
                  </span>
                  <span className="shrink-0 flex items-center gap-1.5">
                    <span className="font-display text-[22px] tabular-nums">{d.winPct}%</span>
                    <ChevronRight className="w-4 h-4 text-muted" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
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
