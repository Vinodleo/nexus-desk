import React, { useState } from "react";
import { recordStats, sumRecords } from "../../services/historyReplay";
import type { TraderRecord } from "../../services/exitExpectancy";
import { MIN_EDGE_R, MIN_TRADER_TRADES } from "../../services/calibration";
import { CLASSIC_IDS, CLASSIC_STRATEGIES, type ClassicId, type ClassicRecords } from "../../services/classicStrategies";
import { Card } from "./ui";
import { pnlTone } from "./format";
import { rSigned } from "./LedgerBreakdown";
import { useLabFeed } from "./labFeed";
import { Fold, LabChip, SignedBar, YearColumns } from "./labUi";
import { classicByYear } from "./DailyLongCard";

// The classic strategies on US and Indian stocks' daily candles since 2016,
// and on funds of gold, bonds and other assets (server/history/stocksLong.ts):
// each strategy's average a trade after costs against the edge a strategy
// needs, year by year, market by market. US breakout's and momentum's records
// decide whether those paper-trade (server/scanner/usBreakout.ts,
// usMomentum.ts); the rest decides nothing.

/** "funds" is absent from older servers. */
type StockMarket = "us" | "nse" | "funds";

export interface StocksLongView {
  running: boolean;
  current: string | null;
  waitingForNse: boolean;
  finished: number;
  total: number;
  run: {
    startedAt: number;
    finishedAt: number | null;
    fromMs: number;
    toMs: number;
    done: StockMarket[];
    problems: { symbol: string; note: string }[];
    adjusted: { symbol: string; count: number }[];
  } | null;
  classic: Partial<Record<StockMarket, ClassicRecords>>;
  cohorts: Partial<Record<StockMarket, Record<string, string[]>>>;
  funds: Partial<Record<StockMarket, string>>;
}

export const isStocksLongView = (body: any): body is StocksLongView =>
  !!body && typeof body.running === "boolean" && !!body.classic && typeof body.classic === "object" && !!body.cohorts;

const MARKETS: { id: StockMarket; label: string }[] = [
  { id: "us", label: "US" },
  { id: "nse", label: "India" },
  { id: "funds", label: "Funds" },
];

/** What each fund holds. */
export const FUND_NAMES: Record<string, string> = {
  GLD: "gold", SLV: "silver", GDX: "gold miners", TLT: "long US government bonds", IEF: "7–10 year US government bonds",
  TIP: "inflation-linked US bonds", LQD: "company bonds", HYG: "high-yield bonds", DBC: "commodities", USO: "oil", UUP: "the US dollar",
  VNQ: "US property", EFA: "shares outside the US", EEM: "emerging-market shares", QQQ: "the Nasdaq 100", IWM: "small US companies",
};
const RUNNING_REFRESH_MS = 60_000;
const day = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const ticker = (symbol: string) => symbol.replace(/\.US$/, "");
const isUs = (symbol: string) => symbol.endsWith(".US");

/** How each strategy trades the funds: no share-market guard (gold and bonds often rise when shares fall). */
const FUND_RULE: Record<ClassicId, string> = {
  breakout: "Buys a close above the last 55 days' high; sells a close below the last 20 days' low, or 2 ATR below the entry.",
  maTrend: "Holds a fund while its 50-day average is above its 200-day; or until 3 ATR below the entry.",
  momentum: "At each week's last close holds the 3 funds that rose most over 90 days (if they rose); or until 3 ATR below the entry.",
};

/** How each strategy trades stocks, in a line (the market's fund guards in place of Bitcoin). */
const STOCK_RULE: Record<ClassicId, (fund: string) => string> = {
  breakout: () => "Buys a close above the last 55 days' high; sells a close below the last 20 days' low, or 2 ATR below the entry.",
  maTrend: (fund) => `Holds a stock while its 50-day average is above its 200-day and ${fund} is above its own; or until 3 ATR below the entry.`,
  momentum: (fund) => `At each week's last close holds the 3 stocks that rose most over 90 days (if they rose), while ${fund} is above its 200-day average; or until 3 ATR below the entry.`,
};

/** Short column names for the table. */
const COLUMN: Record<ClassicId, string> = { breakout: "Breakout", maTrend: "50/200", momentum: "Top 3" };

/** An average in R as a table cell: "+0.12", "—" without trades. */
const Cell: React.FC<{ rec: TraderRecord | undefined }> = ({ rec }) => {
  if (!rec || rec.trades === 0) return <span className="text-right text-muted">—</span>;
  const avg = rec.totalR / rec.trades;
  return <span className={`text-right ${pnlTone(avg)}`}>{rSigned(avg).replace("R", "")}</span>;
};

export const StocksLongCard: React.FC = () => {
  const view = useLabFeed("/api/stocks-long", isStocksLongView, (v) => v.running, RUNNING_REFRESH_MS);
  const [market, setMarket] = useState<StockMarket>("us");
  if (!view) return null;

  // An older server, without the funds: back to US.
  const shown: StockMarket = view.cohorts[market] ? market : "us";
  const markets = MARKETS.filter((m) => view.cohorts[m.id]);
  const classic = view.classic[shown];
  const fund = view.funds[shown] ?? "";
  const isFunds = shown === "funds";
  // A market's stocks: its lists and its index fund.
  const listed = new Set([...Object.values(view.cohorts[shown] ?? {}).flat(), fund]);
  const byYear = classic ? classicByYear(classic) : new Map<string, Partial<Record<ClassicId, TraderRecord>>>();
  const years = [...byYear.keys()].sort();
  const totals = CLASSIC_IDS.map((id) => ({ id, stats: recordStats(sumRecords(years.map((y) => byYear.get(y)?.[id]))) }))
    .filter((t) => t.stats.trades > 0)
    .sort((a, b) => b.stats.avgR - a.stats.avgR);
  const min = Math.min(-0.25, ...totals.map((t) => t.stats.avgR)) * 1.05;
  const max = Math.max(0.25, ...totals.map((t) => t.stats.avgR)) * 1.05;
  const best = totals[0];
  const problems = (view.run?.problems ?? []).filter((p) => listed.has(ticker(p.symbol)) && isUs(p.symbol) === (shown !== "nse"));
  const adjusted = (view.run?.adjusted ?? []).filter((a) => isUs(a.symbol) === (shown !== "nse"));
  const index = markets.findIndex((m) => m.id === shown);

  return (
    <Card aria-label="Stocks on daily candles since 2016" className="flex flex-col gap-2">
      <div>
        <div className="text-sm font-semibold">Stocks on daily candles since 2016</div>
        <div className="text-xs tabular-nums" data-testid="stocks-status">
          {view.running ? (
            <span className="text-ink">
              Replaying: {view.finished} of {view.total} stocks checked
              {view.current ? ` · ${view.waitingForNse ? "waiting for NSE to close before " : ""}${ticker(view.current)}` : ""}
            </span>
          ) : view.run?.finishedAt ? (
            <span className="text-muted">
              2016 – {day(view.run.toMs)} · updated {day(view.run.finishedAt)}
            </span>
          ) : (
            <span className="text-muted">Starts in the background a while after the server does.</span>
          )}
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Stock market"
        className="relative grid p-0.5 rounded-full bg-inset border border-line"
        style={{ gridTemplateColumns: `repeat(${markets.length}, minmax(0, 1fr))` }}
      >
        <span
          aria-hidden="true"
          className="nx-segment-pill absolute inset-y-0.5 left-0.5 rounded-full bg-accent"
          style={{ width: `calc((100% - 4px) / ${markets.length})`, transform: `translateX(${index * 100}%)` }}
        />
        {markets.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={m.id === shown}
            onClick={() => setMarket(m.id)}
            className={`relative min-h-9 rounded-full text-[13px] font-semibold cursor-pointer transition-colors ${m.id === shown ? "text-on-accent" : "text-muted"}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {totals.length === 0 ? (
        <div className="text-xs text-muted">{view.running ? "No results here yet." : "No results here."}</div>
      ) : (
        <>
          <div className="text-xs text-muted leading-snug">
            Average a trade after costs. The upright line marks the {rSigned(MIN_EDGE_R)} a strategy needs to trade.
          </div>
          <ul className="m-0 p-0 list-none flex flex-col" data-testid="stocks-ranking">
            {totals.map(({ id, stats }, k) => {
              const above = stats.trades >= MIN_TRADER_TRADES && stats.avgR >= MIN_EDGE_R;
              return (
                <li key={id} className="flex flex-col gap-1 py-1.5">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-semibold truncate">{CLASSIC_STRATEGIES[id].name}</span>
                    <span className="tabular-nums font-semibold">{rSigned(stats.avgR)}</span>
                  </div>
                  <SignedBar r={stats.avgR} min={min} max={max} mark={MIN_EDGE_R} delayMs={k * 70} />
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] text-muted tabular-nums">
                    <span>
                      {stats.trades.toLocaleString("en-IN")} trades · {stats.winPct}% won
                    </span>
                    <span className="ml-auto">
                      <LabChip status={above ? "passes" : "fails"}>{above ? "Above the bar" : "Below the bar"}</LabChip>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {best && (
            <YearColumns
              key={`${shown}-${best.id}`}
              title={`Best: ${CLASSIC_STRATEGIES[best.id].name}`}
              years={years.map((year) => ({ year, rec: byYear.get(year)?.[best.id] ?? { trades: 0, totalR: 0, wins: 0, winR: 0, lossR: 0 } }))}
              unit="trades"
              testId="stocks-years"
            />
          )}
          <Fold title="Every strategy, year by year">
            <div className="grid gap-x-2 gap-y-1 text-xs tabular-nums" style={{ gridTemplateColumns: "3rem repeat(3, minmax(0, 1fr))" }} data-testid="stocks-table">
              <span />
              {CLASSIC_IDS.map((id) => (
                <span key={id} className="text-right text-[11px] text-muted truncate">
                  {COLUMN[id]}
                </span>
              ))}
              {years.map((y) => (
                <React.Fragment key={y}>
                  <span>{y}</span>
                  {CLASSIC_IDS.map((id) => (
                    <Cell key={id} rec={byYear.get(y)?.[id]} />
                  ))}
                </React.Fragment>
              ))}
            </div>
          </Fold>
        </>
      )}

      <Fold title={isFunds ? "The funds" : "Stocks each year"}>
        <div className="flex flex-col gap-1 text-[11px] text-muted" data-testid="stocks-cohorts">
          {isFunds ? (
            <div>
              {Object.values(view.cohorts.funds ?? {})
                .flat()
                .map((t) => (FUND_NAMES[t] ? `${t} (${FUND_NAMES[t]})` : t))
                .join(", ")}
              . The same funds every year.
            </div>
          ) : (
            <>
              {Object.entries(view.cohorts[shown] ?? {}).map(([year, list]) => (
                <div key={year}>
                  <span className="font-semibold text-ink">{year}</span> {list.join(", ")}
                </div>
              ))}
              <div>Later years use the last list.</div>
            </>
          )}
        </div>
      </Fold>

      <Fold title="How this test works">
        <div className="text-xs text-muted leading-relaxed">
          {isFunds ? (
            <>
              The classic strategies on 16 funds listed in the US, across kinds of assets (gold, silver, bonds, commodities, the dollar, property
              and shares), since 2016: the same funds every year. No share-market guard: gold and bonds often rise when shares fall, which is why
              trend following spread across assets has smoother years than on one market. Candles from Alpaca, adjusted for splits and
              dividends (bond funds' interest included); costs are Alpaca's fees and a typical spread. It decides nothing: paper trading follows
              only if a strategy clearly beats its costs, and only when you say so.
            </>
          ) : (
            <>
              The classic strategies on {shown === "us" ? "US" : "Indian"} stocks' daily candles since 2016. Each year trades only its 20 biggest
              stocks on 1 January, picked before that year's results. {fund}, the market's index fund, stands in for Bitcoin as the market guard.
              {shown === "us"
                ? " Candles from Alpaca, adjusted for splits and dividends; costs are Alpaca's fees and a typical spread."
                : " Candles from Angel One, with splits and bonus issues adjusted; costs are delivery charges (held overnight, about 0.5% a round trip) and a typical spread."}{" "}
              {shown === "us"
                ? `Breakout's and momentum's records here decide whether they paper-trade US stocks (each needs ${rSigned(MIN_EDGE_R)} a trade over ${MIN_TRADER_TRADES}+ trades); moving averages isn't traded.`
                : "It decides nothing: paper trading follows only if a strategy clearly beats its costs, and only when you say so."}
            </>
          )}
        </div>
        <ul className="m-0 p-0 list-none flex flex-col gap-1">
          {CLASSIC_IDS.map((id) => (
            <li key={id} className="text-[11px] text-muted leading-relaxed">
              <span className="font-semibold text-ink">{CLASSIC_STRATEGIES[id].name}:</span> {isFunds ? FUND_RULE[id] : STOCK_RULE[id](fund)}
            </li>
          ))}
        </ul>
        {adjusted.length > 0 && (
          <div className="text-[11px] text-muted" data-testid="stocks-adjusted">
            Splits and bonus issues adjusted: {adjusted.map((a) => `${ticker(a.symbol)} (${a.count})`).join(", ")}.
          </div>
        )}
      </Fold>

      {problems.length > 0 && (
        <div className="text-[11px] text-muted" data-testid="stocks-problems">
          Not replayed: {problems.map((p) => `${ticker(p.symbol)} (${p.note})`).join(", ")}.
        </div>
      )}
    </Card>
  );
};
