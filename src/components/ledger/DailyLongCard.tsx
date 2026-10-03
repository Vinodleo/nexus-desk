import React, { useEffect, useState } from "react";
import { apiFetch } from "../../services/apiClient";
import { profileTotals, recordStats, sumRecords, type HistoryRecords } from "../../services/historyReplay";
import type { TraderRecord } from "../../services/exitExpectancy";
import { DEFAULT_TRAIL_PROFILE, TRAIL_PROFILES, type TrailProfileId } from "../../shared/trailingStop";
import { Card } from "./ui";
import { pnlTone } from "./format";
import { rSigned } from "./LedgerBreakdown";

// Coins on daily candles over every year Binance has (server/history/
// dailyLong.ts): whether the daily coin trading lasts through long falling
// markets (2018, 2022), year by year, trader by trader, and by trailing stop.
// Each year trades only that year's 20 biggest coins on 1 January.

export interface DailyLongView {
  running: boolean;
  current: string | null;
  finished: number;
  total: number;
  run: {
    startedAt: number;
    finishedAt: number | null;
    fromMs: number;
    toMs: number;
    done: number;
    problems: { symbol: string; note: string }[];
  } | null;
  records: HistoryRecords;
  byMarket: Record<string, Partial<Record<TrailProfileId, TraderRecord>>>;
  cohorts: Record<string, string[]>;
}

/** A reply this card can show (an older server has no such route). */
const isView = (body: any): body is DailyLongView =>
  !!body && typeof body.records === "object" && body.records !== null && typeof body.running === "boolean" && typeof body.cohorts === "object";

const RUNNING_REFRESH_MS = 60_000;
const day = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const coin = (symbol: string) => symbol.replace(/\/INR$/, "");

/** Every trader's coin records with `profile`, summed per year (from the quarters), oldest first. */
export function recordsByYear(records: HistoryRecords, profile: TrailProfileId): { year: string; rec: TraderRecord }[] {
  const byYear = new Map<string, TraderRecord[]>();
  for (const [quarter, byKey] of Object.entries(records[profile] ?? {})) {
    const year = quarter.slice(0, 4);
    const recs = Object.entries(byKey).filter(([k]) => k.startsWith("crypto:")).map(([, r]) => r);
    byYear.set(year, [...(byYear.get(year) ?? []), ...recs]);
  }
  return [...byYear.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, recs]) => ({ year, rec: sumRecords(recs) }));
}

/** Each trader's coin record with `profile` over every year, best first. */
export function recordsByTrader(records: HistoryRecords, profile: TrailProfileId): { trader: string; rec: TraderRecord }[] {
  const byTrader = new Map<string, TraderRecord[]>();
  for (const byKey of Object.values(records[profile] ?? {})) {
    for (const [key, rec] of Object.entries(byKey)) {
      if (!key.startsWith("crypto:")) continue;
      const trader = key.slice("crypto:".length);
      byTrader.set(trader, [...(byTrader.get(trader) ?? []), rec]);
    }
  }
  return [...byTrader.entries()]
    .map(([trader, recs]) => ({ trader, rec: sumRecords(recs) }))
    .filter((t) => t.rec.trades > 0)
    .sort((a, b) => b.rec.totalR / b.rec.trades - a.rec.totalR / a.rec.trades);
}

/** A record's figures on one line: setups, share won, average. */
const Figures: React.FC<{ rec: TraderRecord; brief?: boolean }> = ({ rec, brief }) => {
  const stats = recordStats(rec);
  return (
    <span className="text-muted ml-auto">
      {stats.trades} setups · {brief ? "" : `${stats.winPct}% won · `}
      <span className={`font-semibold ${pnlTone(stats.avgR)}`}>{rSigned(stats.avgR)}</span>
    </span>
  );
};

export const DailyLongCard: React.FC<{ trailProfile?: TrailProfileId }> = ({ trailProfile }) => {
  const profile = trailProfile ?? DEFAULT_TRAIL_PROFILE;
  const [view, setView] = useState<DailyLongView | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      apiFetch("/api/daily-long")
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (cancelled || !isView(body)) return;
          setView(body);
          if (body.running) timer = setTimeout(load, RUNNING_REFRESH_MS);
        })
        .catch(() => {});
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!view) return null;
  const years = recordsByYear(view.records, profile);
  const traders = recordsByTrader(view.records, profile);
  const exits = profileTotals(view.records).filter((t) => t.market === "crypto");
  const allYears = sumRecords(years.map((y) => y.rec));
  const coins = Object.entries(view.byMarket)
    .flatMap(([symbol, totals]) => {
      const rec = totals[profile];
      return rec && rec.trades > 0 ? [{ symbol, rec }] : [];
    })
    .sort((a, b) => b.rec.totalR / b.rec.trades - a.rec.totalR / a.rec.trades);

  return (
    <Card aria-label="Coins on daily candles since 2017" className="flex flex-col gap-1">
      <div className="text-sm font-semibold">Coins on daily candles since 2017</div>
      <div className="text-xs text-muted leading-relaxed">
        The traders' daily coin trades over every year Binance has, through the 2018 and 2022 crashes. Each year trades only its 20
        biggest coins on 1 January, picked before that year's results; coins since delisted come from Binance's archive. With your{" "}
        {TRAIL_PROFILES[profile].label.toLowerCase()} trailing stop, held up to 30 days, after fees and spreads.
      </div>

      <div className="text-xs tabular-nums mt-1" data-testid="daily-long-status">
        {view.running ? (
          <span className="text-ink">
            Replaying: {view.finished} of {view.total} coins checked{view.current ? ` · ${coin(view.current)}` : ""}
          </span>
        ) : view.run?.finishedAt ? (
          <span className="text-muted">
            {day(view.run.fromMs)} – {day(view.run.toMs)} · {view.run.done} coins · updated {day(view.run.finishedAt)}
          </span>
        ) : (
          <span className="text-muted">Starts in the background a while after the server does.</span>
        )}
      </div>

      {years.length === 0 ? (
        <div className="text-xs text-muted">{view.running ? "No results yet." : "No results."}</div>
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-1.5" data-testid="daily-long-years">
            <div className="text-[11px] font-semibold text-muted">Every trader together, year by year</div>
            {years.map(({ year, rec }) => (
              <div key={year} className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums">
                <span>{year}</span>
                <Figures rec={rec} />
              </div>
            ))}
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums border-t border-line pt-1.5">
              <span className="font-semibold">All years</span>
              <Figures rec={allYears} />
            </div>
          </div>

          <div className="mt-2 flex flex-col gap-1.5" data-testid="daily-long-traders">
            <div className="text-[11px] font-semibold text-muted">Each trader, all years</div>
            {traders.map(({ trader, rec }) => (
              <div key={trader} className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums">
                <span>{trader}</span>
                <Figures rec={rec} brief />
              </div>
            ))}
          </div>
        </>
      )}

      {exits.length > 0 && (
        <div className="mt-2 p-2.5 rounded-xl bg-inset flex flex-col gap-1.5" data-testid="daily-long-exits">
          <div className="text-[11px] font-semibold text-muted">Every trader, by trailing stop (the same setups)</div>
          {exits.map(({ profile: p, stats }) => (
            <div key={p} className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums">
              <span className={p === profile ? "font-semibold" : "text-muted"}>
                {TRAIL_PROFILES[p].label}
                {p === profile ? " (yours)" : ""}
              </span>
              <span className="text-muted ml-auto">
                {stats.trades} setups · {stats.winPct}% won · <span className={`font-semibold ${pnlTone(stats.avgR)}`}>{rSigned(stats.avgR)}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {coins.length > 0 && (
        <details className="mt-1">
          <summary className="text-[11px] font-semibold text-muted cursor-pointer">Each coin ({coins.length})</summary>
          <ul className="m-0 p-0 list-none flex flex-col mt-1" data-testid="daily-long-coins">
            {coins.map(({ symbol, rec }) => (
              <li key={symbol} className="flex flex-wrap items-baseline justify-between gap-x-2 py-1 text-xs tabular-nums">
                <span>{coin(symbol)}</span>
                <Figures rec={rec} brief />
              </li>
            ))}
          </ul>
        </details>
      )}

      <details className="mt-1">
        <summary className="text-[11px] font-semibold text-muted cursor-pointer">Coins each year</summary>
        <div className="flex flex-col gap-1 mt-1 text-[11px] text-muted" data-testid="daily-long-cohorts">
          {Object.entries(view.cohorts).map(([year, list]) => (
            <div key={year}>
              <span className="font-semibold text-ink">{year}</span> {list.join(", ")}
            </div>
          ))}
          <div>Later years use the last list.</div>
        </div>
      </details>

      {view.run && view.run.problems.length > 0 && (
        <div className="text-[11px] text-muted mt-1">
          Not replayed: {view.run.problems.map((p) => `${coin(p.symbol)} (${p.note})`).join(", ")}.
        </div>
      )}
    </Card>
  );
};
