import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { DEFAULT_TRAIL_PROFILE, type TrailProfileId } from "../../shared/trailingStop";
import { MIN_EDGE_R } from "../../services/calibration";
import { recordStats, sumRecords } from "../../services/historyReplay";
import { CLASSIC_IDS, CLASSIC_STRATEGIES, type ClassicId, type ClassicRecords } from "../../services/classicStrategies";
import type { TraderRecord } from "../../services/exitExpectancy";
import { Card, Segmented } from "./ui";
import { rSigned } from "./LedgerBreakdown";
import { useLabFeed } from "./labFeed";
import { LabChip, type LabStatus } from "./labUi";
import { isDailyCoinsView, shortName, when, type DailyCoinsView } from "./DailyCoinsCard";
import { isUsBreakoutView } from "./UsBreakoutCard";
import { isUsMomentumView } from "./UsMomentumCard";
import { classicByYear, isDailyLongView, recordsByYear, STALE_NOTE } from "./DailyLongCard";
import { isStocksLongView } from "./StocksLongCard";
import { isHistoryView } from "./HistoryCard";

// The Lab's newer parts: on Today, what each scheduled check did last (one
// timeline, the full cards folded under it); on Records, every strategy's
// replayed average side by side in each market, and the picked one year by
// year.

type Run = NonNullable<DailyCoinsView["run"]>;
type Outcome = Run["picks"][number]["outcome"];

/** Each outcome's chip: its words, before the names, and its colours. */
const TAG: Record<Outcome, { words: string; tone: string }> = {
  opened: { words: "Bought", tone: "bg-gain/15 text-gain" },
  sold: { words: "Sold", tone: "bg-accent-soft text-accent" },
  kept: { words: "Kept", tone: "bg-inset text-ink" },
  waiting: { words: "Waited", tone: "bg-warn-soft text-warn" },
  paused: { words: "Paused", tone: "bg-inset text-muted" },
};
const ORDER: Outcome[] = ["opened", "sold", "kept", "waiting", "paused"];

/** A check's picks as one chip per outcome, its names in the order found ("Bought AMZN, GLD"); four names, then how many more. */
export function checkTags(run: Pick<Run, "picks">): { outcome: Outcome; text: string }[] {
  return ORDER.flatMap((outcome) => {
    const names = [...new Set(run.picks.filter((p) => p.outcome === outcome).map((p) => shortName(p.symbol)))];
    if (names.length === 0) return [];
    const shown = names.slice(0, 4).join(", ");
    return [{ outcome, text: `${TAG[outcome].words} ${shown}${names.length > 4 ? ` +${names.length - 4}` : ""}` }];
  });
}

interface TimelineItem {
  id: string;
  title: string;
  at: number;
  text: string;
  tags: { outcome: Outcome; text: string }[];
  dot: string;
}

/** What one check's last run did, in a line. */
function checkLine(run: Run, things: string, empty: string, extra?: string): string {
  const read = `Checked ${run.coins} ${things}${run.failed.length > 0 ? `; ${run.failed.length} couldn't be read` : ""}.`;
  return [read, extra, run.note, run.picks.length === 0 ? empty : undefined].filter(Boolean).join(" ");
}

/**
 * Lab → Today: what the server's scheduled checks did last, newest first, on
 * one line each: when, what it read, and what it bought, sold, kept or left
 * waiting, as chips.
 */
export const ChecksTimeline: React.FC = () => {
  const dc = useLabFeed("/api/daily-coins", isDailyCoinsView);
  const us = useLabFeed("/api/us-breakout", isUsBreakoutView);
  const funds = useLabFeed("/api/funds-breakout", isUsBreakoutView);
  const momentum = useLabFeed("/api/us-momentum", isUsMomentumView);
  const items: TimelineItem[] = [];
  if (dc?.run)
    items.push({ id: "coins", title: "Coin check", at: dc.run.at, text: checkLine(dc.run, "coins", "Nothing to buy or sell that day."), tags: checkTags(dc.run), dot: "bg-gain" });
  if (us?.run) items.push({ id: "us", title: "US breakout check", at: us.run.at, text: checkLine(us.run, "stocks", "No breakouts that day."), tags: checkTags(us.run), dot: "bg-accent" });
  if (funds?.run)
    items.push({ id: "funds", title: "Funds check", at: funds.run.at, text: checkLine(funds.run, "funds", "No breakouts that day."), tags: checkTags(funds.run), dot: "bg-accent" });
  if (momentum?.run) {
    const r = momentum.run;
    const guard =
      r.marketUp === undefined
        ? undefined
        : r.marketUp
          ? `SPY above its 200-day average: it holds the week's top 3${r.top && r.top.length > 0 ? ` (${r.top.map((t) => shortName(t.symbol)).join(", ")})` : ""}.`
          : "SPY below its 200-day average: it holds nothing until it's back above.";
    items.push({ id: "momentum", title: "US momentum check", at: r.at, text: checkLine(r, "stocks", "Nothing to buy or sell that week.", guard), tags: checkTags(r), dot: "bg-accent" });
  }
  if (items.length === 0) return null;
  items.sort((a, b) => b.at - a.at);
  return (
    <Card aria-label="What the checks did" className="flex flex-col gap-1">
      <h2 className="m-0 mb-2 text-sm font-semibold">What the checks did</h2>
      <ol className="m-0 p-0 list-none flex flex-col" data-testid="checks-timeline">
        {items.map((it, i) => (
          <li key={it.id} className="flex gap-3 nx-step-in" style={{ animationDelay: `${150 + i * 90}ms` }} data-testid={`check-${it.id}`}>
            <span aria-hidden="true" className="w-3.5 flex flex-col items-center">
              <span className={`w-2.5 h-2.5 mt-1 rounded-full shadow-[0_0_0_4px_var(--nx-inset)] ${it.dot}`} />
              {i < items.length - 1 && <span className="flex-1 w-0.5 mt-1.5 mb-0.5 bg-line" />}
            </span>
            <span className={`flex-1 min-w-0 flex flex-col gap-1.5 ${i < items.length - 1 ? "pb-3.5" : ""}`}>
              <span className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="font-bold">{it.title}</span>
                <span className="text-muted tabular-nums whitespace-nowrap">{when(it.at)}</span>
              </span>
              <span className="text-[13px] leading-snug text-muted">{it.text}</span>
              {it.tags.length > 0 && (
                <span className="flex flex-wrap gap-1.5">
                  {it.tags.map((t) => (
                    <span key={t.outcome} className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${TAG[t.outcome].tone}`}>
                      {t.text}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
};

export type CheckTab = "coins" | "us" | "funds" | "momentum";
const CHECK_TAB_KEY = "nx-check-tab";
function savedCheckTab(ids: CheckTab[]): CheckTab {
  try {
    const t = localStorage.getItem(CHECK_TAB_KEY);
    return ids.find((id) => id === t) ?? ids[0];
  } catch {
    return ids[0];
  }
}

/**
 * The checks' full cards, folded under the timeline: tap to open, then a tab
 * per check (the last one picked remembered on this device). Every card stays
 * mounted, so each has loaded by the time it's shown.
 */
export const CheckDetails: React.FC<{ tabs: readonly { id: CheckTab; label: string; node: React.ReactNode }[] }> = ({ tabs }) => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<CheckTab>(() => savedCheckTab(tabs.map((t) => t.id)));
  const pick = (t: CheckTab) => {
    setTab(t);
    try {
      localStorage.setItem(CHECK_TAB_KEY, t);
    } catch {
      // Private mode: the pick lasts this visit.
    }
  };
  return (
    <section aria-label="Each check in full" className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="min-h-12 px-4 rounded-2xl bg-surface border border-line flex items-center justify-between gap-3 text-sm font-semibold cursor-pointer"
      >
        Each check in full
        <ChevronDown className={`w-4 h-4 text-muted nx-chevron${open ? " nx-chevron-open" : ""}`} aria-hidden="true" />
      </button>
      <div className={`nx-fold${open ? " nx-fold-open" : ""}`} data-testid="check-details" inert={!open}>
        <div>
          <div className="flex flex-col gap-3 pt-4">
            <Segmented label="Which check" options={tabs} value={tab} onChange={pick} />
            {tabs.map((t) => (
              <div key={t.id} hidden={t.id !== tab} data-testid={`check-tab-${t.id}`}>
                {t.node}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

type RecordMarket = "coins" | "us" | "funds" | "nse";
const MARKET_LABEL: Record<RecordMarket, string> = { coins: "Coins", us: "US", funds: "Funds", nse: "India" };

export interface StrategyRow {
  id: string;
  name: string;
  sub: string;
  avgR: number;
  status: LabStatus;
  label: string;
  /** Its average a trade in each replayed year with trades, oldest first. */
  years: { year: string; r: number; trades: number }[];
}

const yearRows = (years: { year: string; rec: TraderRecord }[]) =>
  years.filter((y) => y.rec.trades > 0).map((y) => ({ year: y.year, r: y.rec.totalR / y.rec.trades, trades: y.rec.trades }));

/** Each classic strategy in a replay's records, year by year, with its totals. */
function classicRows(classic: ClassicRecords, since: string, status: (id: ClassicId) => { status: LabStatus; label: string }): StrategyRow[] {
  const byYear = classicByYear(classic);
  const years = [...byYear.keys()].sort();
  return CLASSIC_IDS.flatMap((id) => {
    const perYear = years.map((year) => ({ year, rec: byYear.get(year)?.[id] ?? sumRecords([]) }));
    const stats = recordStats(sumRecords(perYear.map((y) => y.rec)));
    if (stats.trades === 0) return [];
    return [
      {
        id,
        name: CLASSIC_STRATEGIES[id].name,
        sub: `${since} · ${stats.trades.toLocaleString("en-IN")} trades · ${stats.winPct}% won`,
        avgR: stats.avgR,
        years: yearRows(perYear),
        ...status(id),
      },
    ];
  });
}

const gateStatus = (gate: { on: boolean } | null | undefined): { status: LabStatus; label: string } =>
  gate ? (gate.on ? { status: "trading", label: "Trading" } : { status: "paused", label: "Paused" }) : { status: "off", label: "Not traded" };
const NOT_TRADED = { status: "off" as LabStatus, label: "Not traded" };

/**
 * Lab → Records: every strategy's replayed average a trade in one market at a
 * time (coins, US stocks, the funds, Indian stocks), best first, against the
 * edge a strategy needs to trade, with whether it trades now; and the picked
 * one year by year.
 */
export const StrategyRecords: React.FC<{ trailProfile?: TrailProfileId }> = ({ trailProfile }) => {
  const profile = trailProfile ?? DEFAULT_TRAIL_PROFILE;
  const dl = useLabFeed("/api/daily-long", isDailyLongView);
  const sl = useLabFeed("/api/stocks-long", isStocksLongView);
  const dc = useLabFeed("/api/daily-coins", isDailyCoinsView);
  const hv = useLabFeed("/api/history", isHistoryView);
  const us = useLabFeed("/api/us-breakout", isUsBreakoutView);
  const funds = useLabFeed("/api/funds-breakout", isUsBreakoutView);
  const momentum = useLabFeed("/api/us-momentum", isUsMomentumView);
  const [market, setMarket] = useState<RecordMarket>("coins");
  const [picked, setPicked] = useState<string | null>(null);
  const [year, setYear] = useState<string | null>(null);

  const rowsBy: Partial<Record<RecordMarket, StrategyRow[]>> = {};
  if (dl) {
    const coins: StrategyRow[] = dl.classic
      ? classicRows(dl.classic, "since 2018", (id) =>
          id === "breakout" ? (dl.stale ? { status: "paused", label: "Paused" } : gateStatus(dc?.breakout)) : NOT_TRADED
        )
      : [];
    const traders = recordsByYear(dl.records, profile).filter((y) => y.rec.trades > 0);
    const stats = recordStats(sumRecords(traders.map((y) => y.rec)));
    if (stats.trades > 0) {
      const on = dc?.traders.filter((t) => t.on).length ?? 0;
      coins.push({
        id: "traders",
        name: "Daily traders, all together",
        sub: `since ${traders[0].year} · ${stats.trades.toLocaleString("en-IN")} setups · ${stats.winPct}% won`,
        avgR: stats.avgR,
        years: yearRows(traders),
        ...(dc?.dailyTradersOff
          ? { status: "off", label: "Switched off" }
          : on > 0
            ? { status: "trading", label: `${on} of ${dc!.traders.length} trading` }
            : { status: "paused", label: "Paused" }),
      });
    }
    if (hv) {
      const five = recordsByYear(hv.records, profile).filter((y) => y.rec.trades > 0);
      const s = recordStats(sumRecords(five.map((y) => y.rec)));
      if (s.trades > 0)
        coins.push({
          id: "five",
          name: "5-minute traders, all together",
          sub: `two years · ${s.trades.toLocaleString("en-IN")} setups · ${s.winPct}% won`,
          avgR: s.avgR,
          years: yearRows(five),
          ...NOT_TRADED,
        });
    }
    if (coins.length > 0) rowsBy.coins = coins;
  }
  if (sl) {
    if (sl.classic.us) rowsBy.us = classicRows(sl.classic.us, "since 2016", (id) => (id === "breakout" ? gateStatus(us?.gate) : id === "momentum" ? gateStatus(momentum?.gate) : NOT_TRADED));
    if (sl.classic.funds) rowsBy.funds = classicRows(sl.classic.funds, "since 2016", (id) => (id === "breakout" ? gateStatus(funds?.gate) : NOT_TRADED));
    if (sl.classic.nse) rowsBy.nse = classicRows(sl.classic.nse, "since 2016", () => NOT_TRADED);
  }
  const markets = (["coins", "us", "funds", "nse"] as const).filter((m) => (rowsBy[m]?.length ?? 0) > 0);
  if (markets.length === 0) return null;
  const shown = markets.includes(market) ? market : markets[0];
  const rows = [...rowsBy[shown]!].sort((a, b) => b.avgR - a.avgR);
  const pick = rows.find((r) => r.id === picked) ?? rows[0];
  const lo = Math.min(-0.25, ...rows.map((r) => r.avgR)) * 1.05;
  const hi = Math.max(0.25, ...rows.map((r) => r.avgR)) * 1.05;
  const at = (r: number) => ((Math.max(lo, Math.min(hi, r)) - lo) / (hi - lo)) * 100;
  const pct = (n: number) => `${n.toFixed(2)}%`;

  return (
    <>
      <Card aria-label="Every strategy, side by side" className="flex flex-col gap-3">
        <div>
          <h2 className="m-0 text-sm font-semibold">Every strategy, side by side</h2>
          <p className="m-0 mt-0.5 text-xs text-muted leading-snug">
            Its average a trade after costs, replayed. The dashed line is the {rSigned(MIN_EDGE_R)} a strategy needs to trade. Tap one for its years.
          </p>
        </div>
        {markets.length > 1 && (
          <Segmented
            label="Market"
            options={markets.map((m) => ({ id: m, label: MARKET_LABEL[m] }))}
            value={shown}
            onChange={(m) => {
              setMarket(m);
              setPicked(null);
              setYear(null);
            }}
          />
        )}
        {shown === "coins" && dl?.stale && (
          <div className="text-xs text-warn leading-snug" data-testid="lab-ranking-stale">
            Since 2018: {STALE_NOTE}
          </div>
        )}
        <ul key={shown} className="m-0 p-0 list-none flex flex-col gap-1" data-testid="lab-ranking">
          {rows.map((r, k) => {
            const z = at(0);
            const x = at(r.avgR);
            const on = r.id === pick.id;
            return (
              <li key={r.id} className="nx-step-in" style={{ animationDelay: `${k * 70}ms` }}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setPicked(r.id);
                    setYear(null);
                  }}
                  data-testid={`ranking-${r.id}`}
                  className={`w-full -mx-2 px-2 py-2 rounded-xl flex flex-col gap-1.5 text-left cursor-pointer transition-colors ${on ? "bg-inset" : ""}`}
                  style={{ width: "calc(100% + 1rem)" }}
                >
                  <span className="flex items-baseline justify-between gap-2 text-[13px]">
                    <span className="font-semibold truncate">{r.name}</span>
                    <span className={`font-bold tabular-nums ${r.avgR >= 0 ? "text-gain" : "text-loss"}`}>{rSigned(r.avgR)}</span>
                  </span>
                  <span className="relative h-2 rounded-full bg-inset" aria-hidden="true">
                    <span className="absolute -top-[3px] -bottom-[3px] w-px bg-muted" style={{ left: pct(z) }} />
                    <span className="absolute -top-1 -bottom-1 border-l-[1.5px] border-dashed border-ink/50" style={{ left: pct(at(MIN_EDGE_R)) }} />
                    <span
                      data-testid="ranking-bar"
                      className={`absolute inset-y-0 rounded-full ${r.avgR >= 0 ? "bg-gain nx-grow" : "bg-loss nx-grow-left"}`}
                      style={{ left: pct(Math.min(z, x)), width: pct(Math.abs(x - z)), animationDelay: `${150 + k * 70}ms` }}
                    />
                  </span>
                  <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] text-muted tabular-nums">
                    <span>{r.sub}</span>
                    <span className="ml-auto">
                      <LabChip status={r.status}>{r.label}</LabChip>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
      <YearColumns key={`${shown}-${pick.id}`} row={pick} market={MARKET_LABEL[shown]} year={year} onYear={setYear} />
    </>
  );
};

/** The picked strategy's average a trade in each replayed year, up from the middle or down from it; tap a year for its figure. */
const YearColumns: React.FC<{ row: StrategyRow; market: string; year: string | null; onYear: (y: string | null) => void }> = ({ row, market, year, onYear }) => {
  if (row.years.length === 0) return null;
  const most = Math.max(...row.years.map((y) => Math.abs(y.r)), 0.01);
  const up = row.years.filter((y) => y.r > 0).length;
  return (
    <Card aria-label="Year by year" className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold">Year by year</h2>
        <span className="text-xs text-muted truncate">
          {market} · {row.name}
        </span>
      </div>
      <div className="text-[13px]" data-testid="years-up">
        <strong className={up * 2 >= row.years.length ? "text-gain" : "text-loss"}>
          {up} of {row.years.length} years up
        </strong>{" "}
        <span className="text-muted">· tap a year for its average</span>
      </div>
      <div className="relative h-[150px] mt-4 flex gap-1" data-testid="year-columns">
        <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-line" />
        {row.years.map((y, k) => {
          const h = (Math.abs(y.r) / most) * 46;
          const on = year === y.year;
          return (
            <button
              key={y.year}
              type="button"
              aria-pressed={on}
              aria-label={`${y.year}: ${rSigned(y.r)} a trade over ${y.trades} ${y.trades === 1 ? "trade" : "trades"}`}
              onClick={() => onYear(on ? null : y.year)}
              className="relative flex-1 h-full cursor-pointer"
            >
              <span
                data-testid="year-column"
                className={`absolute left-[12%] right-[12%] rounded nx-rise transition-opacity ${y.r >= 0 ? "bg-gain" : "bg-loss"}`}
                style={{
                  transformOrigin: y.r >= 0 ? "bottom" : "top",
                  top: y.r >= 0 ? `${(50 - h).toFixed(1)}%` : "50%",
                  height: `${h.toFixed(1)}%`,
                  animationDelay: `${200 + k * 50}ms`,
                  opacity: year === null || on ? 1 : 0.35,
                }}
              />
              {on && (
                <span
                  className="absolute left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded-lg bg-ink text-canvas text-[11px] font-bold whitespace-nowrap z-10 nx-badge-pop"
                  style={y.r >= 0 ? { top: `calc(${(50 - h).toFixed(1)}% - 24px)` } : { top: `calc(${(50 + h).toFixed(1)}% + 4px)` }}
                  data-testid="year-tip"
                >
                  {rSigned(y.r)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex gap-1 text-[10px] text-muted tabular-nums" aria-hidden="true">
        {row.years.map((y) => (
          <span key={y.year} className="flex-1 text-center">
            ’{y.year.slice(2)}
          </span>
        ))}
      </div>
    </Card>
  );
};
