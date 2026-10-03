import React, { useEffect, useState } from "react";
import { apiFetch } from "../../services/apiClient";
import { Card } from "./ui";
import { pnlTone } from "./format";
import { rSigned } from "./LedgerBreakdown";

// Coin trades on daily candles (server/scanner/dailyCoins.ts): the server's
// check once a day, what it found and did, and which traders trade (their
// two-year daily record decides). Paper only.

export interface DailyCoinsView {
  run: {
    at: number;
    day: string;
    coins: number;
    failed: string[];
    picks: { symbol: string; trader: string; outcome: "opened" | "waiting" | "paused"; reason?: string }[];
    note?: string;
  } | null;
  traders: { trader: string; trades: number; avgR: number; on: boolean }[];
  nextAt: number;
}

/** A reply this card can show (an older server has no such route). */
const isView = (body: any): body is DailyCoinsView => !!body && Array.isArray(body.traders) && typeof body.nextAt === "number";

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const OUTCOME_LABEL = { opened: "opened", waiting: "not opened", paused: "paused" } as const;

export const DailyCoinsCard: React.FC = () => {
  const [view, setView] = useState<DailyCoinsView | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/daily-coins")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => !cancelled && isView(body) && setView(body))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!view) return null;
  const { run } = view;
  const on = view.traders.filter((t) => t.on);
  const paused = view.traders.filter((t) => !t.on);

  return (
    <Card aria-label="Daily coin trades" className="flex flex-col gap-1">
      <div className="text-sm font-semibold">Daily coin trades (paper)</div>
      <div className="text-xs text-muted leading-relaxed">
        Once a day, just after the daily candle closes (5:30 am), the server checks coins on daily candles and opens paper trades
        within your coin limits. Only traders whose two-year daily record is positive over 10+ setups trade. Trades are held up to
        30 days.
      </div>

      <div className="text-xs tabular-nums mt-1" data-testid="daily-status">
        {run ? (
          <span className="text-ink">
            Last check {when(run.at)} · {run.coins} coins · next {when(view.nextAt)}
          </span>
        ) : (
          <span className="text-muted">First check {when(view.nextAt)}</span>
        )}
      </div>

      {run && (
        <div className="flex flex-col gap-1 mt-1" data-testid="daily-picks">
          {run.note && <div className="text-xs text-warn">{run.note}</div>}
          {run.picks.length === 0 ? (
            <div className="text-xs text-muted">No setups that day.</div>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col">
              {run.picks.map((p) => (
                <li key={`${p.symbol}-${p.trader}`} className="py-1.5 border-b border-line last:border-b-0 text-xs">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0">
                      <span className="font-semibold">{p.symbol.replace(/\/INR$/, "")}</span> <span className="text-muted">{p.trader}</span>
                    </span>
                    <span className={`shrink-0 font-semibold ${p.outcome === "opened" ? "text-accent" : "text-muted"}`}>{OUTCOME_LABEL[p.outcome]}</span>
                  </div>
                  {p.reason && <div className="text-muted">{p.reason}</div>}
                </li>
              ))}
            </ul>
          )}
          {run.failed.length > 0 && (
            <div className="text-[11px] text-muted">Couldn't read: {run.failed.map((s) => s.replace(/\/INR$/, "")).join(", ")}.</div>
          )}
        </div>
      )}

      {view.traders.length > 0 && (
        <div className="mt-2 p-2.5 rounded-xl bg-inset flex flex-col gap-1.5" data-testid="daily-traders">
          <div className="text-[11px] font-semibold text-muted">Two-year daily record with your trailing stop</div>
          {[...on, ...paused].map((t) => (
            <div key={t.trader} className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums">
              <span className={t.on ? "" : "text-muted"}>
                {t.trader}
                {t.on ? "" : " · paused"}
              </span>
              <span className="text-muted ml-auto">
                {t.trades} setups · <span className={`font-semibold ${pnlTone(t.avgR)}`}>{rSigned(t.avgR)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};
