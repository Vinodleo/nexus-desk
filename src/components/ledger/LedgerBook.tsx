import React, { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { HistoricalTrade } from "../../types";
import { TradeAutopsyCard } from "../TradeAutopsyCard";
import { Card, StatTile } from "./ui";
import { EXIT_LABEL, formatMoney, formatPct, formatPrice, pnlTone, stopSlip } from "./format";
import { LedgerBreakdown } from "./LedgerBreakdown";
import { Rolling, staggerDelay, useSlideFrom } from "./motion";

export type BookFilter = "all" | "wins" | "losses";

export { stopSlip };


/** Totals for the summary card. Wins and losses are by net P&L after fees. */
export function summarizeTrades(trades: HistoricalTrade[]) {
  let won = 0;
  let lost = 0;
  let fees = 0;
  let wins = 0;
  for (const t of trades) {
    if (t.realizedPnl > 0) {
      won += t.realizedPnl;
      wins++;
    } else {
      lost += -t.realizedPnl;
    }
    fees += t.feesPaid || 0;
  }
  return {
    count: trades.length,
    net: won - lost,
    won,
    lost,
    fees,
    winPct: trades.length > 0 ? Math.round((wins / trades.length) * 100) : null,
  };
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today", "Yesterday" or "23 Sep"; trades without a timestamp go under "Earlier". */
export function dayLabel(ms: number | undefined, now = Date.now()): string {
  if (!ms) return "Earlier";
  if (dayKey(ms) === dayKey(now)) return "Today";
  if (dayKey(ms) === dayKey(now - 86400000)) return "Yesterday";
  return new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** Stops this close together, in one market, count as one market dip. */
export const LINKED_STOP_GAP_MS = 5 * 60 * 1000;
/** A dip needs at least this many stops. */
export const LINKED_STOP_MIN = 3;

const marketKind = (symbol: string) => (/\.US$/.test(symbol) ? "us" : symbol.includes("/") ? "coins" : "stocks");
const isStopLoss = (t: HistoricalTrade) => t.realizedPnl < 0 && /STOP/.test(t.exitReason);

export type BookItem = { kind: "trade"; trade: HistoricalTrade } | { kind: "dip"; trades: HistoricalTrade[] };

/**
 * Trades newest first, with runs of losing stops that hit within a few
 * minutes of each other in one market gathered into one "market dip": the
 * market fell and took them together, which is one event, not several
 * separate mistakes.
 */
export function groupLinkedStops(trades: HistoricalTrade[]): BookItem[] {
  const out: BookItem[] = [];
  let run: HistoricalTrade[] = [];
  const flush = () => {
    if (run.length >= LINKED_STOP_MIN) out.push({ kind: "dip", trades: run });
    else run.forEach((t) => out.push({ kind: "trade", trade: t }));
    run = [];
  };
  for (const t of trades) {
    const last = run[run.length - 1];
    const linked =
      last &&
      isStopLoss(t) &&
      t.closedAtMs !== undefined &&
      last.closedAtMs !== undefined &&
      Math.abs(last.closedAtMs - t.closedAtMs) <= LINKED_STOP_GAP_MS &&
      marketKind(t.symbol) === marketKind(last.symbol);
    if (!linked) flush();
    if (isStopLoss(t) && t.closedAtMs !== undefined) run.push(t);
    else out.push({ kind: "trade", trade: t });
  }
  flush();
  return out;
}

function heldFor(t: HistoricalTrade): string {
  let mins = t.holdingDurationMinutes;
  if (typeof mins !== "number" && t.openedAtMs && t.closedAtMs) mins = Math.round((t.closedAtMs - t.openedAtMs) / 60000);
  if (typeof mins !== "number" || mins < 0) return "—";
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h} h ${mins % 60} min` : `${Math.round(h / 24)} days`;
}

function timeOf(t: HistoricalTrade): string {
  return t.closedAtMs
    ? new Date(t.closedAtMs).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : t.closedAt;
}

const TradeRow: React.FC<{
  trade: HistoricalTrade;
  open: boolean;
  onToggle: () => void;
  onUpdateTrade?: (t: HistoricalTrade) => void;
  /** Place in the list as it shows, for the stagger. */
  index?: number;
}> = ({ trade: t, open, onToggle, onUpdateTrade, index = 0 }) => {
  const tone = pnlTone(t.realizedPnl);
  const reason = EXIT_LABEL[t.exitReason] ?? t.exitReason;
  return (
    <li className="border-b border-line nx-row-in" style={{ animationDelay: staggerDelay(index) }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 py-3 text-left cursor-pointer"
      >
        <span className="min-w-0 flex flex-col gap-0.5">
          <span>
            <span className="font-semibold">{t.symbol}</span>{" "}
            <span className="text-xs text-muted">
              {t.direction === "LONG" ? "Long" : "Short"} · {t.quantity}
            </span>
          </span>
          <span className="text-xs text-muted tabular-nums">
            {timeOf(t)} · {reason}
            {t.isSelfApproved ? (t.openedByServer ? " · autopilot (server)" : " · autopilot") : ""}
          </span>
          {!open && t.autopsy && <span className="text-xs font-semibold text-accent">Read autopsy</span>}
        </span>
        <span className="shrink-0 flex items-center gap-1.5">
          <span className={`font-display text-[19px] tabular-nums whitespace-nowrap ${tone}`}>
            {formatMoney(t.realizedPnl, { signed: true })}
          </span>
          <ChevronDown className={`w-4 h-4 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <div className="pb-4 flex flex-col gap-3 nx-row-in">
          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 text-xs tabular-nums">
            <div>
              <dt className="text-muted">Entry → exit</dt>
              <dd className="m-0 font-semibold">
                {formatPrice(t.entryPrice)} → {formatPrice(t.exitPrice)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Return</dt>
              <dd className={`m-0 font-semibold ${tone}`}>{formatPct(t.realizedPnlPercent)}</dd>
            </div>
            <div>
              <dt className="text-muted">Money placed</dt>
              <dd className="m-0 font-semibold">{formatMoney(t.moneyPlaced)}</dd>
            </div>
            <div>
              <dt className="text-muted">Fees</dt>
              <dd className="m-0 font-semibold">{formatMoney(t.feesPaid || 0)}</dd>
            </div>
            <div>
              <dt className="text-muted">Held for</dt>
              <dd className="m-0 font-semibold">{heldFor(t)}</dd>
            </div>
            <div>
              <dt className="text-muted">Setup</dt>
              <dd className="m-0 font-semibold truncate">{t.setupName}</dd>
            </div>
            {stopSlip(t) && (
              <div className="col-span-2">
                <dt className="text-muted">Stop → sold at</dt>
                <dd className="m-0 font-semibold">
                  {formatPrice(t.stopAtExit!)} → {formatPrice(t.fillAtExit!)}
                  {stopSlip(t)!.pct >= 0.05 && (
                    <span className="text-loss font-normal">
                      {" "}
                      · {stopSlip(t)!.pct.toFixed(2)}% past the stop: the price moved through it between checks
                    </span>
                  )}
                </dd>
              </div>
            )}
          </dl>
          <TradeAutopsyCard trade={t} onUpdateTrade={onUpdateTrade} />
        </div>
      )}
    </li>
  );
};

const PAGE = 30;

export const LedgerBookTrades: React.FC<{
  trades: HistoricalTrade[];
  onUpdateTrade?: (t: HistoricalTrade) => void;
}> = ({ trades, onUpdateTrade }) => {
  const [filter, setFilter] = useState<BookFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const summary = useMemo(() => summarizeTrades(trades), [trades]);

  const filtered = useMemo(() => {
    const list =
      filter === "wins" ? trades.filter((t) => t.realizedPnl > 0) : filter === "losses" ? trades.filter((t) => t.realizedPnl <= 0) : trades;
    // Newest first.
    return [...list].sort((a, b) => (b.closedAtMs ?? 0) - (a.closedAtMs ?? 0));
  }, [trades, filter]);

  const groups = useMemo(() => {
    const out: { label: string; trades: HistoricalTrade[] }[] = [];
    for (const t of filtered.slice(0, shown)) {
      const label = dayLabel(t.closedAtMs);
      const last = out[out.length - 1];
      if (last && last.label === label) last.trades.push(t);
      else out.push({ label, trades: [t] });
    }
    return out;
  }, [filtered, shown]);

  const chips: { id: BookFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "wins", label: "Wins" },
    { id: "losses", label: "Losses" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-muted">Net P&amp;L, closed trades</div>
            <div className={`font-display text-[34px] leading-tight tabular-nums ${pnlTone(summary.net)}`}>
              <Rolling value={summary.net} format={(n) => formatMoney(n, { signed: true })} from={0} ms={700} />
            </div>
          </div>
          <div className="text-right text-xs text-muted tabular-nums">
            {summary.count} {summary.count === 1 ? "trade" : "trades"}
            {summary.winPct !== null && (
              <>
                <br />
                {summary.winPct}% won
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <StatTile label="Won" value={formatMoney(summary.won, { decimals: 0 })} valueClassName="text-base text-gain" />
          <StatTile label="Lost" value={formatMoney(summary.lost, { decimals: 0 })} valueClassName="text-base text-loss" />
          <StatTile label="Fees" value={formatMoney(summary.fees, { decimals: 0 })} valueClassName="text-base" />
        </div>
      </Card>

      <div className="flex gap-2" role="group" aria-label="Filter trades">
        {chips.map((c) => {
          const on = filter === c.id;
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setFilter(c.id);
                setShown(PAGE);
              }}
              className={`min-h-9 px-3.5 rounded-full border text-[13px] font-semibold cursor-pointer ${
                on ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-ink"
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <p className="m-0 py-6 text-sm text-muted text-center">
          {trades.length === 0 ? "No closed trades yet. They'll appear here as positions close." : "No trades match this filter."}
        </p>
      ) : (
        <section key={filter} aria-label="Closed trades" className="flex flex-col">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="text-xs font-semibold text-muted uppercase tracking-[0.08em] pt-2.5">{g.label}</div>
              <ul className="list-none m-0 p-0">
                {groupLinkedStops(g.trades).map((item) =>
                  item.kind === "dip" ? (
                    <DipGroup
                      key={`dip-${item.trades[0].id}`}
                      trades={item.trades}
                      openId={openId}
                      onToggle={(id) => setOpenId(openId === id ? null : id)}
                      onUpdateTrade={onUpdateTrade}
                    />
                  ) : (
                    <TradeRow
                      key={item.trade.id}
                      index={filtered.indexOf(item.trade) % PAGE}
                      trade={item.trade}
                      open={openId === item.trade.id}
                      onToggle={() => setOpenId(openId === item.trade.id ? null : item.trade.id)}
                      onUpdateTrade={onUpdateTrade}
                    />
                  )
                )}
              </ul>
            </div>
          ))}
          {filtered.length > shown && (
            <button
              type="button"
              onClick={() => setShown(shown + PAGE)}
              className="mt-3 min-h-11 rounded-full border border-line bg-surface text-sm font-semibold cursor-pointer"
            >
              Show {Math.min(PAGE, filtered.length - shown)} more
            </button>
          )}
        </section>
      )}
    </div>
  );
};

/**
 * A market dip: several stops that hit together, folded into one card.
 * Tap to fan the trades out (they stagger in), tap again to fold them.
 */
const DipGroup: React.FC<{ trades: HistoricalTrade[]; openId: string | null; onToggle: (id: string) => void; onUpdateTrade?: (t: HistoricalTrade) => void }> = ({
  trades,
  openId,
  onToggle,
  onUpdateTrade,
}) => {
  const [open, setOpen] = useState(false);
  const total = trades.reduce((a, t) => a + t.realizedPnl, 0);
  const times = trades.map((t) => t.closedAtMs as number);
  const first = Math.min(...times);
  const last = Math.max(...times);
  const mins = Math.max(1, Math.round((last - first) / 60000));
  const names = trades.map((t) => t.symbol.split("/")[0].replace(/\.US$/, "")).join(", ");
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <li className="border-b border-line nx-row-in">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-full my-2 p-3 rounded-xl bg-warn-soft text-warn-ink text-left cursor-pointer flex flex-col gap-1"
      >
        <span className="flex items-baseline justify-between gap-3">
          <strong className="text-sm">Market dip · {trades.length} stops</strong>
          <span className="font-display text-[19px] tabular-nums text-loss">{formatMoney(total, { signed: true })}</span>
        </span>
        <span className="text-xs">
          {names} within {mins} {mins === 1 ? "minute" : "minutes"} ({hhmm(first)}–{hhmm(last)}): the market fell and took them together.{" "}
          {open ? "Tap to fold." : "Tap to see each."}
        </span>
      </button>
      {open && (
        <ul className="list-none m-0 p-0 pl-3 ml-1.5 border-l-2 border-danger-line">
          {trades.map((t, i) => (
            <TradeRow key={t.id} index={i} trade={t} open={openId === t.id} onToggle={() => onToggle(t.id)} onUpdateTrade={onUpdateTrade} />
          ))}
        </ul>
      )}
    </li>
  );
};

export interface LedgerBookProps {
  trades: HistoricalTrade[];
  onUpdateTrade?: (t: HistoricalTrade) => void;
  /** The Risk section, rendered when that tab is picked. */
  risk: React.ReactNode;
  /** Whether a limit or drill is blocking new trades; flags the Risk tab. */
  riskBlocked?: boolean;
}

type Section = "trades" | "breakdown" | "risk";
const SECTIONS: readonly Section[] = ["trades", "breakdown", "risk"];

export const LedgerBook: React.FC<LedgerBookProps> = ({ trades, onUpdateTrade, risk, riskBlocked }) => {
  const [section, setSection] = useState<Section>("trades");
  const slideClass = useSlideFrom(section, SECTIONS);
  return (
    <div className="font-ui text-ink flex flex-col gap-4 pb-4 select-none">
      <header className="pt-1">
        <h1 className="m-0 font-display text-[26px] font-semibold">Book</h1>
        <div className="text-[13px] text-muted">
          {section === "trades"
            ? "Every closed trade, newest first"
            : section === "breakdown"
            ? "Where the money is made and lost"
            : "Limits and safety checks"}
        </div>
      </header>
      <div className="relative flex p-1 rounded-full bg-surface border border-line" role="tablist" aria-label="Book sections">
        {/* The picked section's pill slides across. */}
        <span aria-hidden="true" className="absolute inset-y-1 left-1 w-[calc((100%_-_0.5rem)/3)] pointer-events-none">
          <span
            data-testid="book-section-pill"
            className="nx-segment-pill block h-full rounded-full bg-accent"
            style={{ transform: `translateX(${SECTIONS.indexOf(section) * 100}%)` }}
          />
        </span>
        {SECTIONS.map((s) => {
          const on = section === s;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setSection(s)}
              className={`relative flex-1 min-h-10 rounded-full text-sm font-semibold cursor-pointer flex items-center justify-center gap-1.5 transition-colors ${
                on ? "text-on-accent" : "text-muted"
              }`}
            >
              {s === "trades" ? "Trades" : s === "breakdown" ? "Breakdown" : "Risk"}
              {s === "risk" && riskBlocked && (
                <span className="w-2 h-2 rounded-full bg-loss" aria-label="blocked" />
              )}
            </button>
          );
        })}
      </div>
      <div key={section} className={slideClass}>
        {section === "trades" ? (
          <LedgerBookTrades trades={trades} onUpdateTrade={onUpdateTrade} />
        ) : section === "breakdown" ? (
          <LedgerBreakdown trades={trades} />
        ) : (
          risk
        )}
      </div>
    </div>
  );
};
