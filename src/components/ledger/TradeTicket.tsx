import React, { useEffect, useId } from "react";
import type { Position } from "../../types";
import { marketOf } from "../../shared/marketLimits";
import { isFundSymbol } from "../../shared/funds";
import { formatMoney, formatPrice } from "./format";
import { atStop, moneyIn } from "./LedgerFloor";
import { cashTiedUp } from "../../shared/paperCash";

// When a trade opens with the app on screen, a ticket unfolds over it: what
// was bought, at what price, where its stop is and why it was taken, and on
// paper how much free cash it took. Several at once (the US checks can open a
// few together) queue up, one ticket after another.

export interface TicketTrade {
  position: Position;
  /** Who opened it: the server's autopilot, the phone's, or the owner from the Queue. */
  by: "server" | "autopilot" | "you";
  /** Paper only: the paper money, and the free cash before and after this trade. */
  cash?: { money: number; before: number; after: number };
}

/** The ticket for a newly opened trade; on paper, the free cash it takes from what was free before. */
export function ticketFor(position: Position, by: TicketTrade["by"], paper?: { money: number; freeBefore: number }): TicketTrade {
  if (!paper || position.isLiveOrder) return { position, by };
  const after = Math.max(0, paper.freeBefore - cashTiedUp(position));
  return { position, by, cash: { money: paper.money, before: paper.freeBefore, after } };
}

/** What kind of trade it is, in a few words. */
export function ticketKind(p: Position): string {
  if (p.strategy === "momentum") return "US momentum, top 3";
  if (p.strategy === "breakout") {
    if (isFundSymbol(p.symbol)) return "Funds breakout 55/20";
    return marketOf(p.symbol) === "coins" ? "Coin breakout 55/20" : "US breakout 55/20";
  }
  if (p.timeframe === "1d") return `Daily trade · ${p.setupName}`;
  return p.setupName;
}

/** Why the slower strategies took it, in their own rules; null for the others (their setup's name says it). */
export function ticketWhy(p: Position): string | null {
  if (p.strategy === "momentum") {
    return "Of this year's 20 biggest US stocks, one of the 3 that rose most over 90 sessions, with SPY above its 200-day average. The stop sits 3 ATR below.";
  }
  if (p.strategy === "breakout") {
    const when = marketOf(p.symbol) === "coins" ? "It closed above its 55-day high at the daily check." : "It was above its 55-day high at the 3:45 pm New York check.";
    return `${when} The stop sits 2 ATR below, and it sells on a close below its 20-day low.`;
  }
  return null;
}

const BY: Record<TicketTrade["by"], string> = { server: "by the server", autopilot: "by the autopilot", you: "by you" };

export const TradeTicket: React.FC<{ tickets: TicketTrade[]; onNext: () => void; onDone: () => void; onOpenFloor: () => void }> = ({
  tickets,
  onNext,
  onDone,
  onOpenFloor,
}) => {
  const titleId = useId();
  useEffect(() => {
    if (tickets.length === 0) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onDone();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tickets.length, onDone]);
  const t = tickets[0];
  if (!t) return null;
  const p = t.position;
  const more = tickets.length - 1;
  const live = !!p.isLiveOrder;
  const stopPnl = atStop(p);
  const why = ticketWhy(p);
  const rows: { k: string; v: string; tone?: string }[] = [
    { k: "Price", v: `₹${formatPrice(p.entryPrice)}` },
    { k: p.symbol.endsWith(".US") ? "Shares" : "Quantity", v: String(p.quantity) },
    { k: "Money in it", v: formatMoney(moneyIn(p), { decimals: 0 }) },
    { k: "Stop", v: `₹${formatPrice(p.stopLoss)}` },
    { k: "At the stop, before fees", v: formatMoney(stopPnl, { signed: true, decimals: 0 }), tone: stopPnl < 0 ? "text-loss" : "text-gain" },
    ...(!p.strategy && p.takeProfit > 0 ? [{ k: "Target", v: `₹${formatPrice(p.takeProfit)}` }] : []),
  ];
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / Math.max(1, t.cash?.money ?? 1)) * 100)).toFixed(1)}%`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[max(1.25rem,env(safe-area-inset-top))] font-ui text-ink overflow-y-auto">
      <div className="absolute inset-0 bg-scrim/40 backdrop-blur-sm nx-fade-in" onClick={onDone} aria-hidden="true" />
      {/* Keyed on the trade, so the next ticket unfolds afresh. */}
      <div key={p.id} role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative w-full max-w-sm my-4" data-testid="trade-ticket">
        <div className="nx-ticket-unfold nx-notch-bottom bg-surface rounded-t-[26px] px-6 pt-6 pb-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-bold tracking-[0.08em] text-muted">TRADE OPENED</div>
              <h2 id={titleId} className="m-0 mt-1.5 font-display text-[32px] leading-tight font-semibold truncate">
                {p.symbol}
              </h2>
              <div className="text-[13px] text-muted">
                {ticketKind(p)} · {BY[t.by]}
              </div>
            </div>
            <span
              data-testid="ticket-stamp"
              className={`nx-ticket-stamp shrink-0 mt-1.5 px-2.5 py-1 rounded-lg border-[2.5px] text-[13px] font-bold tracking-[0.14em] ${
                live ? "border-warn text-warn" : "border-accent text-accent"
              }`}
            >
              {live ? "LIVE" : "PAPER"}
            </span>
          </div>
          <dl className="m-0 mt-5 flex flex-col gap-2.5">
            {rows.map((r, i) => (
              <div key={r.k} className="flex justify-between gap-3 text-sm nx-row-in" style={{ animationDelay: `${650 + i * 80}ms` }}>
                <dt className="text-muted">{r.k}</dt>
                <dd className={`m-0 font-semibold tabular-nums text-right ${r.tone ?? ""}`}>{r.v}</dd>
              </div>
            ))}
          </dl>
          {why && (
            <p className="m-0 mt-4 px-3 py-2.5 rounded-xl bg-accent-soft text-xs leading-relaxed nx-row-in" style={{ animationDelay: "1100ms" }}>
              <b>Why:</b> {why}
            </p>
          )}
        </div>
        {/* Notched where the ticket tears. */}
        <div className="nx-ticket-stub nx-notch-top relative bg-surface rounded-b-[26px] px-6 pt-5 pb-6 border-t-2 border-dashed border-line">
          {t.cash ? (
            <div data-testid="ticket-cash">
              <div className="flex justify-between gap-3 text-xs text-muted tabular-nums">
                <span>Free cash</span>
                <span>
                  <s>{formatMoney(t.cash.before, { decimals: 0 })}</s> → <b className="text-ink">{formatMoney(t.cash.after, { decimals: 0 })}</b>
                </span>
              </div>
              <div className="relative h-2.5 mt-2.5 rounded-full bg-inset overflow-hidden" aria-hidden="true">
                <div className="absolute inset-y-0 left-0 rounded-full bg-accent/25" style={{ width: pct(t.cash.before) }} />
                <div
                  className="nx-ticket-drain absolute inset-y-0 left-0 rounded-full bg-accent"
                  style={{ width: pct(t.cash.after), "--nx-from": pct(t.cash.before) } as React.CSSProperties}
                />
              </div>
              <div className="text-xs text-muted mt-2">
                {formatMoney(t.cash.before - t.cash.after, { decimals: 0 })} is tied up in this trade until it closes.
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted">{live ? "A real CoinDCX order. The server guards its stop around the clock." : "Guarded on the server around the clock."}</div>
          )}
        </div>
        <div className="flex gap-2 mt-4 nx-row-in" style={{ animationDelay: "1500ms" }}>
          <button
            type="button"
            onClick={onOpenFloor}
            className="flex-1 h-12 rounded-full border border-line bg-surface text-sm font-semibold cursor-pointer"
          >
            See it on the Floor
          </button>
          <button
            type="button"
            autoFocus
            onClick={more > 0 ? onNext : onDone}
            className="flex-1 h-12 rounded-full bg-accent text-on-accent text-sm font-semibold cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            {more > 0 ? `Next (${more} more)` : "Got it"}
          </button>
        </div>
      </div>
    </div>
  );
};
