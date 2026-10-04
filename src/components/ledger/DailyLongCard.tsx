import React from "react";
import { useLabFeed } from "./labFeed";
import { Fold } from "./labUi";
import { profileTotals, recordStats, sumRecords, type HistoryRecords } from "../../services/historyReplay";
import type { TraderRecord } from "../../services/exitExpectancy";
import { DEFAULT_TRAIL_PROFILE, TRAIL_PROFILES, type TrailProfileId } from "../../shared/trailingStop";
import { CLASSIC_IDS, CLASSIC_STRATEGIES, type ClassicId, type ClassicRecords } from "../../services/classicStrategies";
import { Card } from "./ui";
import { pnlTone } from "./format";
import { rSigned } from "./LedgerBreakdown";

// Coins on daily candles over every year Binance has (server/history/
// dailyLong.ts): whether the daily coin trading lasts through long falling
// markets (2018, 2022), year by year, trader by trader, and by trailing stop.
// Each year trades only that year's 20 biggest coins on 1 January.

export interface DailyLongView {
  running: boolean;
  /** The results are from an older version of the replay (the old coin fee): on show until it runs again, nothing trades on them. Missing on an older server. */
  stale?: boolean;
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
  /** The classic strategies on the same coins and years (absent until they've run, or from older servers). */
  classic?: ClassicRecords | null;
  byMarket: Record<string, Partial<Record<TrailProfileId, TraderRecord>>>;
  cohorts: Record<string, string[]>;
}

/** The classic strategies' records, summed per year (from the quarters), each strategy's. */
export function classicByYear(classic: ClassicRecords): Map<string, Partial<Record<ClassicId, TraderRecord>>> {
  const out = new Map<string, Partial<Record<ClassicId, TraderRecord>>>();
  for (const [quarter, byStrategy] of Object.entries(classic)) {
    const year = quarter.slice(0, 4);
    const row = out.get(year) ?? {};
    for (const id of CLASSIC_IDS) {
      const rec = byStrategy[id];
      if (rec) row[id] = sumRecords([row[id], rec]);
    }
    out.set(year, row);
  }
  return out;
}

/** Short column names for the comparison table. */
const COLUMN: Record<"traders" | ClassicId, string> = { traders: "Traders", breakout: "Breakout", maTrend: "50/200", momentum: "Top 3" };

/** An average in R as a table cell: "+0.12", "—" without trades. */
const Cell: React.FC<{ rec: TraderRecord | undefined; strong?: boolean }> = ({ rec, strong }) => {
  if (!rec || rec.trades === 0) return <span className="text-right text-muted">—</span>;
  const avg = rec.totalR / rec.trades;
  return <span className={`text-right ${strong ? "font-semibold " : ""}${pnlTone(avg)}`}>{rSigned(avg).replace("R", "")}</span>;
};

/** A reply this card can show (an older server has no such route). */
export const isDailyLongView = (body: any): body is DailyLongView =>
  !!body && typeof body.records === "object" && body.records !== null && typeof body.running === "boolean" && typeof body.cohorts === "object";

const RUNNING_REFRESH_MS = 60_000;
/** Said while the results are from the old coin fee and wait to be replayed again. */
export const STALE_NOTE = "From the old 0.05% coin fee: it replays with CoinDCX's real 0.59% once the other background work is done. Nothing trades on these meanwhile.";
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
  const view = useLabFeed("/api/daily-long", isDailyLongView, (v) => v.running, RUNNING_REFRESH_MS);

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
      <div className="text-xs tabular-nums" data-testid="daily-long-status">
        {view.running ? (
          <span className="text-ink">
            Replaying: {view.finished} of {view.total} coins checked{view.current ? ` · ${coin(view.current)}` : ""}
          </span>
        ) : view.stale ? (
          <span className="text-warn">{STALE_NOTE}</span>
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
          <Fold title="Every trader together, year by year">
            <div className="flex flex-col gap-1.5" data-testid="daily-long-years">
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
          </Fold>

          <Fold title="Each trader, all years">
            <div className="flex flex-col gap-1.5" data-testid="daily-long-traders">
              {traders.map(({ trader, rec }) => (
                <div key={trader} className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums">
                  <span>{trader}</span>
                  <Figures rec={rec} brief />
                </div>
              ))}
            </div>
          </Fold>
        </>
      )}

      {view.classic && Object.keys(view.classic).length > 0 && (
        <Fold title="Classic strategies next to your traders">
          <ClassicTable classic={view.classic} years={years} />
        </Fold>
      )}

      {exits.length > 0 && (
        <Fold title="Trailing stops compared">
          <div className="flex flex-col gap-1.5" data-testid="daily-long-exits">
            <div className="text-[11px] text-muted">Every trader, by trailing stop (the same setups)</div>
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
        </Fold>
      )}

      {coins.length > 0 && (
        <Fold title={`Each coin (${coins.length})`}>
          <ul className="m-0 p-0 list-none flex flex-col" data-testid="daily-long-coins">
            {coins.map(({ symbol, rec }) => (
              <li key={symbol} className="flex flex-wrap items-baseline justify-between gap-x-2 py-1 text-xs tabular-nums">
                <span>{coin(symbol)}</span>
                <Figures rec={rec} brief />
              </li>
            ))}
          </ul>
        </Fold>
      )}

      <Fold title="Coins each year">
        <div className="flex flex-col gap-1 text-[11px] text-muted" data-testid="daily-long-cohorts">
          {Object.entries(view.cohorts).map(([year, list]) => (
            <div key={year}>
              <span className="font-semibold text-ink">{year}</span> {list.join(", ")}
            </div>
          ))}
          <div>Later years use the last list.</div>
        </div>
      </Fold>

      <Fold title="How this replay works">
        <div className="text-xs text-muted leading-relaxed">
          The traders' daily coin trades over every year Binance has, through the 2018 and 2022 crashes. Each year trades only its 20
          biggest coins on 1 January, picked before that year's results; coins since delisted come from Binance's archive. With your{" "}
          {TRAIL_PROFILES[profile].label.toLowerCase()} trailing stop, held up to 30 days, after fees and spreads. Each trader's record here
          decides whether it takes daily paper trades.
        </div>
      </Fold>

      {view.run && view.run.problems.length > 0 && (
        <div className="text-[11px] text-muted mt-1">
          Not replayed: {view.run.problems.map((p) => `${coin(p.symbol)} (${p.note})`).join(", ")}.
        </div>
      )}
    </Card>
  );
};

/**
 * The classic strategies next to your traders, year by year (average R a
 * trade, after costs), then each strategy's total and rule.
 */
const ClassicTable: React.FC<{ classic: ClassicRecords; years: { year: string; rec: TraderRecord }[] }> = ({ classic, years }) => {
  const byYear = classicByYear(classic);
  const allYears = [...new Set([...years.map((y) => y.year), ...byYear.keys()])].sort();
  const tradersByYear = new Map(years.map((y) => [y.year, y.rec]));
  const totals = Object.fromEntries(CLASSIC_IDS.map((id) => [id, sumRecords(allYears.map((y) => byYear.get(y)?.[id]))])) as Record<ClassicId, TraderRecord>;
  const columns = ["traders", ...CLASSIC_IDS] as const;
  const grid = { gridTemplateColumns: "3rem repeat(4, minmax(0, 1fr))" };
  return (
    <div className="flex flex-col gap-1.5" data-testid="daily-long-classic">
      <div className="text-[11px] text-muted">On the same coins and years, average R a trade</div>
      <div className="grid gap-x-2 gap-y-1 text-xs tabular-nums" style={grid}>
        <span />
        {columns.map((c) => (
          <span key={c} className="text-right text-[11px] text-muted truncate">
            {COLUMN[c]}
          </span>
        ))}
        {allYears.map((y) => (
          <React.Fragment key={y}>
            <span>{y}</span>
            <Cell rec={tradersByYear.get(y)} />
            {CLASSIC_IDS.map((id) => (
              <Cell key={id} rec={byYear.get(y)?.[id]} />
            ))}
          </React.Fragment>
        ))}
        <span className="font-semibold border-t border-line pt-1">All</span>
        <span className="border-t border-line pt-1 text-right">
          <Cell rec={sumRecords(years.map((y) => y.rec))} strong />
        </span>
        {CLASSIC_IDS.map((id) => (
          <span key={id} className="border-t border-line pt-1 text-right">
            <Cell rec={totals[id]} strong />
          </span>
        ))}
      </div>
      <ul className="m-0 p-0 list-none flex flex-col gap-1.5 mt-1" data-testid="daily-long-classic-rules">
        {CLASSIC_IDS.map((id) => (
          <li key={id} className="text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 tabular-nums">
              <span className="font-semibold">{CLASSIC_STRATEGIES[id].name}</span>
              <span className="text-muted ml-auto">
                {totals[id].trades} trades · {recordStats(totals[id]).winPct}% won ·{" "}
                <span className={`font-semibold ${pnlTone(recordStats(totals[id]).avgR)}`}>{rSigned(recordStats(totals[id]).avgR)}</span>
              </span>
            </div>
            <div className="text-[11px] text-muted leading-relaxed">{CLASSIC_STRATEGIES[id].rule}</div>
          </li>
        ))}
      </ul>
    </div>
  );
};
