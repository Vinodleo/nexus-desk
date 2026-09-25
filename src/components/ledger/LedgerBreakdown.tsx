import React, { useEffect, useMemo, useState } from "react";
import type { HistoricalTrade } from "../../types";
import { apiFetch } from "../../services/apiClient";
import { MIN_EDGE_R } from "../../services/calibration";
import { Card, StatTile } from "./ui";
import { EXIT_LABEL, formatMoney, pnlTone, stopSlip } from "./format";

// Where the book's money goes: average win against average loss, and the
// same by trader, coin and exit. Plus the scanner's own record of each
// trader with your exits, which decides who is allowed to trade.

export interface BreakdownRow {
  key: string;
  count: number;
  wins: number;
  net: number;
  avgWin: number;
  avgLoss: number;
  /** Average result in R, over trades that recorded their risk at open; null if none did. */
  avgR: number | null;
  /** Average % a stop exit sold past its stop, over those recorded; null if none. */
  avgSlipPct: number | null;
}

/** Trades grouped by `keyOf`, the costliest first. */
export function breakdown(trades: HistoricalTrade[], keyOf: (t: HistoricalTrade) => string): BreakdownRow[] {
  const groups = new Map<string, HistoricalTrade[]>();
  for (const t of trades) {
    const k = keyOf(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const wins = list.filter((t) => t.realizedPnl > 0);
      const losses = list.filter((t) => t.realizedPnl <= 0);
      const sum = (l: HistoricalTrade[]) => l.reduce((a, t) => a + t.realizedPnl, 0);
      const withRisk = list.filter((t) => (t.riskAtOpen ?? 0) > 0);
      return {
        key,
        count: list.length,
        wins: wins.length,
        net: sum(list),
        avgWin: wins.length > 0 ? sum(wins) / wins.length : 0,
        avgLoss: losses.length > 0 ? sum(losses) / losses.length : 0,
        avgR: withRisk.length > 0 ? withRisk.reduce((a, t) => a + t.realizedPnl / t.riskAtOpen!, 0) / withRisk.length : null,
        avgSlipPct: (() => {
          const slips = list.map(stopSlip).filter((s): s is { pct: number } => s !== null);
          return slips.length > 0 ? slips.reduce((a, s) => a + s.pct, 0) / slips.length : null;
        })(),
      };
    })
    .sort((a, b) => a.net - b.net);
}

/** The headline: how big wins and losses are, and the win rate that breaks even with them. */
export function payoffSummary(trades: HistoricalTrade[]) {
  const [all] = breakdown(trades, () => "all");
  if (!all) return null;
  const avgLoss = Math.abs(all.avgLoss);
  const breakEvenWinPct = all.avgWin + avgLoss > 0 ? Math.round((avgLoss / (all.avgWin + avgLoss)) * 100) : null;
  return {
    count: all.count,
    winPct: Math.round((all.wins / all.count) * 100),
    avgWin: all.avgWin,
    avgLoss,
    breakEvenWinPct,
    avgR: all.avgR,
  };
}

const rSigned = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;

const Rows: React.FC<{ title: string; rows: BreakdownRow[]; limit?: number }> = ({ title, rows, limit }) => {
  if (rows.length === 0) return null;
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <Card aria-label={title} className="flex flex-col gap-1">
      <div className="text-sm font-semibold">{title}</div>
      <ul className="m-0 p-0 list-none flex flex-col">
        {shown.map((r) => (
          <li key={r.key} className="flex items-start justify-between gap-3 py-2 border-b border-line last:border-b-0">
            <div className="min-w-0">
              <div className="text-sm truncate">{r.key}</div>
              <div className="text-xs text-muted tabular-nums">
                {r.count} {r.count === 1 ? "trade" : "trades"} · {Math.round((r.wins / r.count) * 100)}% won
                {r.avgR !== null && ` · ${rSigned(r.avgR)} avg`}
              </div>
              <div className="text-xs text-muted tabular-nums">
                avg win {formatMoney(r.avgWin, { decimals: 0 })} · avg loss {formatMoney(Math.abs(r.avgLoss), { decimals: 0 })}
              </div>
              {r.avgSlipPct !== null && r.avgSlipPct >= 0.05 && (
                <div className="text-xs text-loss tabular-nums">stops sold {r.avgSlipPct.toFixed(2)}% past the stop on average</div>
              )}
            </div>
            <div className={`text-sm font-semibold tabular-nums shrink-0 ${pnlTone(r.net)}`}>{formatMoney(r.net, { signed: true, decimals: 0 })}</div>
          </li>
        ))}
      </ul>
      {limit && rows.length > limit && <div className="text-xs text-muted">Showing the {limit} costliest of {rows.length}.</div>}
    </Card>
  );
};

interface EdgeRow {
  market: "crypto" | "nse";
  trader: string;
  trades: number;
  winPct: number;
  avgWinR: number;
  avgLossR: number;
  avgR: number;
  judgedR: number;
}
interface EdgeTable {
  profile: string;
  measuredAt: number;
  symbols: number;
  minMarketTrades: number;
  rows: EdgeRow[];
}

interface CoinActivity {
  minActivity: number;
  coins: { symbol: string; activity: number | null; spreadPct: number | null }[];
}

/** What the server measures: each trader's record with your exits, and each coin's trading costs. */
function useScannerMeasures() {
  const [measures, setMeasures] = useState<{ table: EdgeTable | null; activity: CoinActivity | null }>({ table: null, activity: null });
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/scanner/exit-edge")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => !cancelled && setMeasures({ table: body?.table ?? null, activity: body?.activity ?? null }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return measures;
}

/** Each coin's spread and how often it trades; coins trading too rarely are skipped. */
const CoinCosts: React.FC<{ activity: CoinActivity | null }> = ({ activity }) => {
  if (!activity || activity.coins.length === 0) return null;
  return (
    <Card aria-label="What coins cost to trade" className="flex flex-col gap-1">
      <div className="text-sm font-semibold">What coins cost to trade</div>
      <div className="text-xs text-muted">
        The spread is the gap between the cheapest seller and the highest buyer: a trade buys at the one and sells at the other, so it pays
        the spread once, on top of fees. A coin that goes minutes without a trade jumps when the next one comes; those trading in under{" "}
        {Math.round(activity.minActivity * 100)}% of the last two hours' minutes aren't traded.
      </div>
      <ul className="m-0 p-0 list-none flex flex-col">
        {activity.coins.map((c) => {
          const skipped = c.activity !== null && c.activity < activity.minActivity;
          return (
            <li key={c.symbol} className="flex items-center justify-between gap-3 py-2 border-b border-line last:border-b-0">
              <span className="text-sm">{c.symbol}</span>
              <span className={`text-xs tabular-nums text-right ${skipped ? "text-loss" : "text-muted"}`}>
                {c.spreadPct !== null && `spread ${(c.spreadPct * 100).toFixed(2)}%`}
                {c.spreadPct !== null && c.activity !== null && " · "}
                {c.activity !== null && `trades in ${Math.round(c.activity * 100)}% of minutes`}
                {skipped && " · skipped"}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
};

/** The scanner's record of each trader with your exits: who may trade now. */
const TraderRecord: React.FC<{ table: EdgeTable | null }> = ({ table }) => {
  if (!table || table.rows.length === 0) return null;
  const markets = (["crypto", "nse"] as const).filter((m) => table.rows.some((r) => r.market === m));
  return (
    <Card aria-label="Traders with your exits" className="flex flex-col gap-1">
      <div className="text-sm font-semibold">Traders with your exits</div>
      <div className="text-xs text-muted">
        Every setup each trader found over the last day ({table.symbols} markets), played out with your {table.profile} trailing stop, the half
        banked at +1R and the time limit, after fees. A trader averaging under {rSigned(MIN_EDGE_R)} doesn't trade until they recover.
      </div>
      {markets.map((m) => {
        const rows = table.rows.filter((r) => r.market === m);
        const measured = rows.reduce((n, r) => n + r.trades, 0);
        const judging = measured >= table.minMarketTrades;
        return (
          <div key={m} className="flex flex-col">
            <div className="text-xs font-semibold text-muted mt-2">{m === "crypto" ? "Coins" : "Stocks"}</div>
            {!judging && (
              <div className="text-xs text-muted">
                {measured} setups so far; trading isn't limited by this until there are {table.minMarketTrades}.
              </div>
            )}
            <ul className="m-0 p-0 list-none flex flex-col">
              {rows.map((r) => {
                const paused = judging && r.judgedR < MIN_EDGE_R;
                return (
                  <li key={r.trader} className="flex items-start justify-between gap-3 py-2 border-b border-line last:border-b-0">
                    <div className="min-w-0">
                      <div className="text-sm truncate">{r.trader}</div>
                      <div className="text-xs text-muted tabular-nums">
                        {r.trades} setups · {r.winPct}% won · win {rSigned(r.avgWinR)} · loss {rSigned(r.avgLossR)}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`text-sm font-semibold tabular-nums ${pnlTone(r.avgR)}`}>{rSigned(r.avgR)}</div>
                      {judging && <div className={`text-xs ${paused ? "text-loss" : "text-gain"}`}>{paused ? "Paused" : "Trading"}</div>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </Card>
  );
};

type Range = "week" | "all";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const LedgerBreakdown: React.FC<{ trades: HistoricalTrade[]; now?: number }> = ({ trades, now = Date.now() }) => {
  const [range, setRange] = useState<Range>("week");
  const inRange = useMemo(
    () => (range === "all" ? trades : trades.filter((t) => (t.closedAtMs ?? 0) >= now - WEEK_MS)),
    [trades, range, now]
  );
  const summary = payoffSummary(inRange);
  const byTrader = useMemo(() => breakdown(inRange, (t) => t.setupName || "Unknown"), [inRange]);
  const byCoin = useMemo(() => breakdown(inRange, (t) => t.symbol), [inRange]);
  const byExit = useMemo(() => breakdown(inRange, (t) => EXIT_LABEL[t.exitReason] ?? t.exitReason), [inRange]);
  const measures = useScannerMeasures();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2" role="group" aria-label="Period">
        {(
          [
            ["week", "Last 7 days"],
            ["all", "All"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={range === id}
            onClick={() => setRange(id)}
            className={`min-h-9 px-3.5 rounded-full border text-[13px] font-semibold cursor-pointer ${
              range === id ? "bg-accent-soft border-accent text-accent" : "border-line text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {summary ? (
        <Card aria-label="Wins against losses" className="flex flex-col gap-3">
          <div className="text-sm">
            Winners average <b className="text-gain">{formatMoney(summary.avgWin, { decimals: 0 })}</b> and losers{" "}
            <b className="text-loss">{formatMoney(summary.avgLoss, { decimals: 0 })}</b>
            {summary.breakEvenWinPct !== null && (
              <>
                , so breaking even takes winning <b>{summary.breakEvenWinPct}%</b> of trades. You won <b>{summary.winPct}%</b>
                {summary.winPct >= summary.breakEvenWinPct ? "." : ": wins are too small for the losses."}
              </>
            )}
          </div>
          <div className="flex gap-2">
            <StatTile label="Avg win" value={formatMoney(summary.avgWin, { decimals: 0 })} valueClassName="text-base text-gain" />
            <StatTile label="Avg loss" value={formatMoney(summary.avgLoss, { decimals: 0 })} valueClassName="text-base text-loss" />
            <StatTile
              label="Per trade"
              value={summary.avgR !== null ? rSigned(summary.avgR) : "—"}
              valueClassName={`text-base ${summary.avgR !== null ? pnlTone(summary.avgR) : ""}`}
            />
          </div>
        </Card>
      ) : (
        <Card>
          <div className="text-sm text-muted">No closed trades in this period.</div>
        </Card>
      )}

      <TraderRecord table={measures.table} />
      <Rows title="By trader" rows={byTrader} />
      <Rows title="By coin" rows={byCoin} limit={8} />
      <CoinCosts activity={measures.activity} />
      <Rows title="By exit" rows={byExit} />
    </div>
  );
};
