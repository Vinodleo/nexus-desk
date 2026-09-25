import React, { useEffect, useId, useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import type { AwayNoticeState } from "../../hooks/useAwayNotice";
import { formatAway } from "../../services/awaySummary";
import { EXIT_LABEL, formatMoney, pnlTone } from "./format";
import { prefersReducedMotion, useAnimatedNumber } from "./motion";

/** How long the "Back online" pill stays up. */
export const PILL_MS = 3500;

// What's shown on unlocking the phone: a small pill that drops in from the
// top ("Syncing…", then "Back online"), or, when trades opened or closed
// while the phone was locked, a "While you were away" card.
export const AwayNotice: React.FC<{
  notice: AwayNoticeState | null;
  onDismiss: () => void;
  onOpenBook?: () => void;
}> = ({ notice, onDismiss, onOpenBook }) => {
  if (!notice) return null;
  if (notice.phase === "card") return <AwayCard key={notice.id} notice={notice} onDismiss={onDismiss} onOpenBook={onOpenBook} />;
  return <AwayPill notice={notice} onDismiss={onDismiss} />;
};

const AwayPill: React.FC<{ notice: Extract<AwayNoticeState, { phase: "syncing" | "pill" }>; onDismiss: () => void }> = ({
  notice,
  onDismiss,
}) => {
  const [leaving, setLeaving] = useState(false);
  const touchY = useRef<number | null>(null);
  const done = notice.phase === "pill";

  useEffect(() => setLeaving(false), [notice.id]);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setLeaving(true), PILL_MS);
    return () => clearTimeout(t);
  }, [done, notice.id]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(onDismiss, prefersReducedMotion() ? 0 : 260);
    return () => clearTimeout(t);
  }, [leaving, onDismiss]);

  const awayMs = notice.phase === "pill" ? notice.summary.awayMs : notice.awayMs;

  return (
    <div
      role="status"
      aria-live="polite"
      onClick={() => setLeaving(true)}
      onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? null)}
      onTouchEnd={(e) => {
        const y = e.changedTouches[0]?.clientY;
        if (touchY.current !== null && y !== undefined && y - touchY.current < -20) setLeaving(true);
        touchY.current = null;
      }}
      className={`fixed left-1/2 top-3 z-50 max-w-[calc(100vw-32px)] font-ui text-ink cursor-pointer select-none ${
        leaving ? "nx-lift-out" : "nx-drop-in"
      }`}
      style={{ transform: "translate(-50%, 0)" }}
    >
      <div className="relative overflow-hidden flex items-center gap-2.5 pl-3 pr-4 py-2 rounded-full bg-surface border border-line shadow-lg">
        <span
          className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${done ? "bg-gain text-on-accent" : "bg-accent-soft text-accent"}`}
        >
          {done ? (
            <Check key="tick" className="w-3.5 h-3.5 nx-tick-in" strokeWidth={2.5} />
          ) : (
            <RefreshCw className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
          )}
        </span>
        <span className="text-[13px] font-semibold whitespace-nowrap">{done ? "Back online" : "Syncing…"}</span>
        <span className="text-[12px] text-muted whitespace-nowrap truncate">
          {done ? "prices updated" : `away ${formatAway(awayMs)}`}
        </span>
        {done && (
          <span
            aria-hidden="true"
            className="absolute left-0 bottom-0 h-[2px] w-full bg-gain/60 nx-countdown"
            style={{ animationDuration: `${PILL_MS}ms` }}
          />
        )}
      </div>
    </div>
  );
};

const AwayCard: React.FC<{
  notice: Extract<AwayNoticeState, { phase: "card" }>;
  onDismiss: () => void;
  onOpenBook?: () => void;
}> = ({ notice, onDismiss, onOpenBook }) => {
  const titleId = useId();
  const { summary } = notice;
  const net = useAnimatedNumber(summary.netPnl, 700, 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onDismiss();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const rows = [
    ...summary.closed.map((t) => ({
      key: `c-${t.id}`,
      left: t.symbol,
      sub: `Closed · ${EXIT_LABEL[t.exitReason] ?? t.exitReason}`,
      right: <span className={`tabular-nums font-semibold ${pnlTone(t.pnl)}`}>{formatMoney(t.pnl, { signed: true })}</span>,
    })),
    ...summary.opened.map((p) => ({
      key: `o-${p.id}`,
      left: p.symbol,
      sub: p.byServer ? "Bought by the server" : "Bought",
      right: <span className="text-[12px] text-accent font-semibold">Open</span>,
    })),
  ];
  const shownRows = rows.slice(0, 6);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 font-ui text-ink">
      <div className="absolute inset-0 bg-ink/30 backdrop-blur-sm nx-fade-in" onClick={onDismiss} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-sm bg-canvas rounded-3xl shadow-xl p-5 nx-pop-in"
      >
        <div className="text-[12px] text-muted">Away {formatAway(summary.awayMs)}</div>
        <h2 id={titleId} className="m-0 font-display text-2xl font-semibold">
          While you were away
        </h2>

        {summary.closed.length > 0 && (
          <div className="mt-3">
            <div className={`font-display text-[34px] leading-none font-semibold tabular-nums ${pnlTone(summary.netPnl)}`}>
              {formatMoney(net, { signed: true })}
            </div>
            <div className="text-[12px] text-muted mt-1">
              from {summary.closed.length} closed trade{summary.closed.length === 1 ? "" : "s"}
            </div>
          </div>
        )}

        <ul className="m-0 mt-4 p-0 list-none divide-y divide-line border-y border-line">
          {shownRows.map((r, i) => (
            <li key={r.key} className="flex items-center justify-between gap-3 py-2.5 nx-row-in" style={{ animationDelay: `${120 + i * 70}ms` }}>
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{r.left}</div>
                <div className="text-[12px] text-muted">{r.sub}</div>
              </div>
              {r.right}
            </li>
          ))}
        </ul>
        {rows.length > shownRows.length && (
          <div className="text-[12px] text-muted mt-2">and {rows.length - shownRows.length} more</div>
        )}

        <div className="flex gap-2 mt-4">
          {onOpenBook && summary.closed.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onDismiss();
                onOpenBook();
              }}
              className="flex-1 h-11 rounded-full border border-line bg-surface text-sm font-semibold cursor-pointer hover:bg-inset"
            >
              See the Book
            </button>
          )}
          <button
            type="button"
            autoFocus
            onClick={onDismiss}
            className="flex-1 h-11 rounded-full bg-accent text-on-accent text-sm font-semibold cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
