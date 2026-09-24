import React, { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { HistoricalTrade } from "../../types";
import { TradeAutopsyCard } from "../TradeAutopsyCard";
import { Card, StatTile } from "./ui";
import { formatMoney, formatPct, formatPrice, pnlTone } from "./format";

export type BookFilter = "all" | "wins" | "losses";

const EXIT_LABEL: Record<HistoricalTrade["exitReason"], string> = {
  TAKE_PROFIT: "Take profit",
  STOP_LOSS: "Stop loss",
  TRAILING_STOP: "Trailing stop",
  MANUAL: "Closed by you",
  EXPIRY_TIME: "Time limit",
};

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
}> = ({ trade: t, open, onToggle, onUpdateTrade }) => {
  const tone = pnlTone(t.realizedPnl);
  const reason = EXIT_LABEL[t.exitReason] ?? t.exitReason;
  return (
    <li className="border-b border-line">
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
            {t.isSelfApproved ? " · autopilot" : ""}
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
        <div className="pb-4 flex flex-col gap-3">
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
              {formatMoney(summary.net, { signed: true })}
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
        <section aria-label="Closed trades" className="flex flex-col">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="text-xs font-semibold text-muted uppercase tracking-[0.08em] pt-2.5">{g.label}</div>
              <ul className="list-none m-0 p-0">
                {g.trades.map((t) => (
                  <TradeRow
                    key={t.id}
                    trade={t}
                    open={openId === t.id}
                    onToggle={() => setOpenId(openId === t.id ? null : t.id)}
                    onUpdateTrade={onUpdateTrade}
                  />
                ))}
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

export interface LedgerBookProps {
  trades: HistoricalTrade[];
  onUpdateTrade?: (t: HistoricalTrade) => void;
  /** The Risk section, rendered when that tab is picked. */
  risk: React.ReactNode;
  /** Whether a limit or drill is blocking new trades; flags the Risk tab. */
  riskBlocked?: boolean;
}

export const LedgerBook: React.FC<LedgerBookProps> = ({ trades, onUpdateTrade, risk, riskBlocked }) => {
  const [section, setSection] = useState<"trades" | "risk">("trades");
  return (
    <div className="font-ui text-ink flex flex-col gap-4 pb-4 select-none">
      <header className="pt-1">
        <h1 className="m-0 font-display text-[26px] font-semibold">Book</h1>
        <div className="text-[13px] text-muted">
          {section === "trades" ? "Every closed trade, newest first" : "Limits and safety checks"}
        </div>
      </header>
      <div className="flex p-1 rounded-full bg-surface border border-line" role="tablist" aria-label="Book sections">
        {(["trades", "risk"] as const).map((s) => {
          const on = section === s;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setSection(s)}
              className={`flex-1 min-h-10 rounded-full text-sm font-semibold cursor-pointer flex items-center justify-center gap-1.5 ${
                on ? "bg-accent text-on-accent" : "text-muted"
              }`}
            >
              {s === "trades" ? "Trades" : "Risk"}
              {s === "risk" && riskBlocked && (
                <span className="w-2 h-2 rounded-full bg-loss" aria-label="blocked" />
              )}
            </button>
          );
        })}
      </div>
      {section === "trades" ? <LedgerBookTrades trades={trades} onUpdateTrade={onUpdateTrade} /> : risk}
    </div>
  );
};
