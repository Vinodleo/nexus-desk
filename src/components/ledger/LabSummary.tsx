import React from "react";
import { DEFAULT_TRAIL_PROFILE, type TrailProfileId } from "../../shared/trailingStop";
import { MIN_EDGE_R } from "../../services/calibration";
import { recordStats, sumRecords } from "../../services/historyReplay";
import { CLASSIC_IDS, CLASSIC_STRATEGIES } from "../../services/classicStrategies";
import { Card } from "./ui";
import { edgePaused, recordSpan, rSigned, type EdgeTable } from "./LedgerBreakdown";
import { useLabFeed } from "./labFeed";
import { LabChip, SignedBar, YearColumns, type LabStatus } from "./labUi";
import { isDailyCoinsView, type DailyCoinsView } from "./DailyCoinsCard";
import { classicByYear, isDailyLongView, recordsByYear, STALE_NOTE } from "./DailyLongCard";
import { isHistoryView } from "./HistoryCard";
import { isMlTestView } from "./MlTestCard";
import { isUsBreakoutView } from "./UsBreakoutCard";
import { isUsMomentumView } from "./UsMomentumCard";

// The Lab's answers first: what's trading now and why (the Today tab), and
// every coin strategy's record side by side, overall and year by year (the
// Records tab). The details stay in the cards below them.

export type LabTab = "today" | "records" | "tests" | "tools";

interface EdgeView {
  table: EdgeTable | null;
}
const isEdgeView = (body: any): body is EdgeView => !!body && "table" in body;

/** How many of the daily traders trade now, as a status. */
function dailyStatus(dc: DailyCoinsView): { status: LabStatus; label: string } {
  if (dc.dailyTradersOff) return { status: "off", label: "Switched off" };
  const on = dc.traders.filter((t) => t.on).length;
  return on > 0 ? { status: "trading", label: `${on} of ${dc.traders.length} trading` } : { status: "paused", label: "Paused" };
}

/** How many 5-minute traders (in each market) trade now, as a status. */
function fiveMinuteStatus(table: EdgeTable, market?: EdgeTable["rows"][number]["market"]): { status: LabStatus; label: string; of: number } {
  const rows = table.rows.filter((r) => !market || r.market === market);
  const trading = rows.filter((r) => !edgePaused(table, r)).length;
  return trading > 0 ? { status: "trading", label: `${trading} of ${rows.length} trading`, of: rows.length } : { status: "paused", label: "Paused", of: rows.length };
}

const SummaryRow: React.FC<{ name: string; status: LabStatus; label: string; detail: string; onOpen?: () => void }> = ({ name, status, label, detail, onOpen }) => {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold truncate">{name}</span>
          <LabChip status={status}>{label}</LabChip>
        </span>
        <span className="block text-xs text-muted tabular-nums">{detail}</span>
      </span>
      {/* The arrow's place is kept on a row without one, so the chips line up. */}
      <span aria-hidden="true" className={`text-muted text-lg leading-none ${onOpen ? "" : "invisible"}`}>
        ›
      </span>
    </>
  );
  const row = "w-full flex items-center gap-2 py-2 text-left border-b border-line last:border-b-0";
  return onOpen ? (
    <button type="button" onClick={onOpen} className={`${row} cursor-pointer`}>
      {body}
    </button>
  ) : (
    <div className={row}>{body}</div>
  );
};

/** The Today tab's first card: each kind of trading, whether it's on, and the record that decides. */
export const LabSummary: React.FC<{ onOpen?: (tab: LabTab) => void }> = ({ onOpen }) => {
  const dc = useLabFeed("/api/daily-coins", isDailyCoinsView);
  const edge = useLabFeed("/api/scanner/exit-edge", isEdgeView);
  const ml = useLabFeed("/api/ml-test", isMlTestView);
  const us = useLabFeed("/api/us-breakout", isUsBreakoutView);
  const momentum = useLabFeed("/api/us-momentum", isUsMomentumView);
  const funds = useLabFeed("/api/funds-breakout", isUsBreakoutView);
  const rows: React.ReactNode[] = [];

  if (dc && dc.traders.length > 0) {
    const setups = dc.traders.reduce((n, t) => n + t.trades, 0);
    const avg = setups > 0 ? dc.traders.reduce((n, t) => n + t.avgR * t.trades, 0) / setups : 0;
    rows.push(
      <SummaryRow
        key="daily"
        name="Daily traders"
        {...dailyStatus(dc)}
        detail={`${rSigned(avg)} a trade ${dc.recordSpan ?? "over two years"}, all together · ${setups.toLocaleString("en-IN")} setups`}
        onOpen={onOpen && (() => onOpen("records"))}
      />
    );
  }
  // No coin records to judge on yet (the replay since 2017 is running, or waits to run with the real fee): both wait.
  if (dc && dc.traders.length === 0 && !dc.breakout) {
    rows.push(
      <SummaryRow
        key="coins-waiting"
        name="Coin breakout and daily traders"
        status="paused"
        label="Paused"
        detail="waiting for the replay since 2017 to finish: its records decide"
        onOpen={onOpen && (() => onOpen("records"))}
      />
    );
  }
  if (dc?.breakout) {
    rows.push(
      <SummaryRow
        key="breakout"
        name={`Coin ${dc.breakout.trader.charAt(0).toLowerCase()}${dc.breakout.trader.slice(1)}`}
        status={dc.breakout.on ? "trading" : "paused"}
        label={dc.breakout.on ? "Trading" : "Paused"}
        detail={`${rSigned(dc.breakout.avgR)} a trade since 2018 · ${dc.breakout.trades} trades`}
        onOpen={onOpen && (() => onOpen("records"))}
      />
    );
  }
  if (us?.gate) {
    rows.push(
      <SummaryRow
        key="us-breakout"
        name="US breakout 55/20"
        status={us.gate.on ? "trading" : "paused"}
        label={us.gate.on ? "Trading" : "Paused"}
        detail={`${rSigned(us.gate.avgR)} a trade since 2016 · ${us.gate.trades} trades`}
        onOpen={onOpen && (() => onOpen("records"))}
      />
    );
  }
  if (funds?.gate) {
    rows.push(
      <SummaryRow
        key="funds-breakout"
        name="Funds breakout 55/20"
        status={funds.gate.on ? "trading" : "paused"}
        label={funds.gate.on ? "Trading" : "Paused"}
        detail={`${rSigned(funds.gate.avgR)} a trade since 2016 · ${funds.gate.trades} trades · gold, bonds and more`}
        onOpen={onOpen && (() => onOpen("records"))}
      />
    );
  }
  if (momentum?.gate) {
    rows.push(
      <SummaryRow
        key="us-momentum"
        name="US momentum, top 3"
        status={momentum.gate.on ? "trading" : "paused"}
        label={momentum.gate.on ? "Trading" : "Paused"}
        detail={`${rSigned(momentum.gate.avgR)} a trade since 2016 · ${momentum.gate.trades} trades · weekly`}
        onOpen={onOpen && (() => onOpen("records"))}
      />
    );
  }
  if (edge?.table && edge.table.rows.length > 0) {
    const s = fiveMinuteStatus(edge.table);
    rows.push(
      <SummaryRow
        key="five"
        name="5-minute traders"
        status={s.status}
        label={s.label}
        detail={`each trader in each market, with your exits · ${recordSpan(edge.table).replace(/ \(.*\)$/, "")}`}
      />
    );
  }
  const coins = ml?.daily?.result?.markets.crypto;
  if (coins) {
    rows.push(
      <SummaryRow
        key="ml"
        name="Machine-learning filter"
        status={coins.passed ? "passes" : "fails"}
        label={coins.passed ? "Passes" : "Doesn't pass"}
        detail={`its picks ${rSigned(coins.picks.avgR)} against ${rSigned(coins.everySetup.avgR)} for every setup · not used live`}
        onOpen={onOpen && (() => onOpen("tests"))}
      />
    );
  }
  if (rows.length === 0) return null;
  return (
    <Card aria-label="What's trading" className="flex flex-col">
      <div className="text-[11px] font-semibold text-muted uppercase tracking-[0.08em]">What's trading</div>
      <div className="flex flex-col" data-testid="lab-summary">
        {rows}
      </div>
    </Card>
  );
};

/**
 * The Records tab's first card: every coin strategy's average a trade after
 * costs, best first, against the edge a strategy needs to trade, with whether
 * it trades now.
 */
export const StrategyRanking: React.FC<{ trailProfile?: TrailProfileId }> = ({ trailProfile }) => {
  const profile = trailProfile ?? DEFAULT_TRAIL_PROFILE;
  const dl = useLabFeed("/api/daily-long", isDailyLongView);
  const dc = useLabFeed("/api/daily-coins", isDailyCoinsView);
  const hv = useLabFeed("/api/history", isHistoryView);
  const edge = useLabFeed("/api/scanner/exit-edge", isEdgeView);

  const rows: { name: string; sub: string; avgR: number; status: LabStatus; label: string }[] = [];
  if (dl?.classic) {
    for (const id of CLASSIC_IDS) {
      const stats = recordStats(sumRecords(Object.values(dl.classic).map((q) => q[id])));
      if (stats.trades === 0) continue;
      const breakout = id === "breakout" && dc?.breakout;
      rows.push({
        name: CLASSIC_STRATEGIES[id].name,
        sub: `since 2018 · ${stats.trades.toLocaleString("en-IN")} trades · ${stats.winPct}% won`,
        avgR: stats.avgR,
        ...(breakout
          ? { status: dc!.breakout!.on ? "trading" : "paused", label: dc!.breakout!.on ? "Trading" : "Paused" }
          : id === "breakout" && dl.stale
            ? { status: "paused", label: "Paused" }
            : { status: "off", label: "Not traded" }),
      });
    }
  }
  if (dl) {
    const years = recordsByYear(dl.records, profile).filter((y) => y.rec.trades > 0);
    const stats = recordStats(sumRecords(years.map((y) => y.rec)));
    if (stats.trades > 0)
      rows.push({
        name: "Daily traders, all together",
        sub: `since ${years[0].year} · ${stats.trades.toLocaleString("en-IN")} setups · ${stats.winPct}% won`,
        avgR: stats.avgR,
        ...(dc && dc.traders.length > 0 ? dailyStatus(dc) : dl.stale ? { status: "paused", label: "Paused" } : { status: "off", label: "Not traded" }),
      });
  }
  if (hv) {
    const stats = recordStats(sumRecords(recordsByYear(hv.records, profile).map((y) => y.rec)));
    if (stats.trades > 0)
      rows.push({
        name: "5-minute traders, all together",
        sub: `two years · ${stats.trades.toLocaleString("en-IN")} setups · ${stats.winPct}% won`,
        avgR: stats.avgR,
        ...(edge?.table && edge.table.rows.some((r) => r.market === "crypto") ? fiveMinuteStatus(edge.table, "crypto") : { status: "off", label: "—" }),
      });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => b.avgR - a.avgR);
  const min = Math.min(-0.25, ...rows.map((r) => r.avgR)) * 1.05;
  const max = Math.max(0.25, ...rows.map((r) => r.avgR)) * 1.05;

  return (
    <Card aria-label="Coin strategies" className="flex flex-col gap-1">
      <div className="text-sm font-semibold">Coin strategies, average a trade</div>
      <div className="text-xs text-muted leading-snug">
        After fees and spreads, with your trailing stop. The upright line marks the {rSigned(MIN_EDGE_R)} a strategy needs to trade.
      </div>
      {dl?.stale && (
        <div className="text-xs text-warn leading-snug" data-testid="lab-ranking-stale">
          Since 2018: {STALE_NOTE}
        </div>
      )}
      <ul className="m-0 p-0 list-none flex flex-col mt-1" data-testid="lab-ranking">
        {rows.map((r, k) => (
          <li key={r.name} className="flex flex-col gap-1 py-1.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-semibold truncate">{r.name}</span>
              <span className="tabular-nums font-semibold">{rSigned(r.avgR)}</span>
            </div>
            <SignedBar r={r.avgR} min={min} max={max} mark={MIN_EDGE_R} delayMs={k * 70} />
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] text-muted tabular-nums">
              <span>{r.sub}</span>
              <span className="ml-auto">
                <LabChip status={r.status}>{r.label}</LabChip>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
};

/** The Records tab's second card: breakout's and the daily traders' average a trade, year by year. */
export const YearByYear: React.FC<{ trailProfile?: TrailProfileId }> = ({ trailProfile }) => {
  const profile = trailProfile ?? DEFAULT_TRAIL_PROFILE;
  const dl = useLabFeed("/api/daily-long", isDailyLongView);
  if (!dl) return null;
  const traders = recordsByYear(dl.records, profile);
  const breakout = dl.classic
    ? [...classicByYear(dl.classic).entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([year, row]) => (row.breakout ? [{ year, rec: row.breakout }] : []))
    : [];
  if (!traders.some((y) => y.rec.trades > 0) && breakout.length === 0) return null;
  return (
    <Card aria-label="Year by year" className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-semibold">Year by year</div>
        <div className="text-xs text-muted">Average a trade on daily coin candles, each chart on its own scale.</div>
      </div>
      {breakout.length > 0 && <YearColumns title={CLASSIC_STRATEGIES.breakout.name} years={breakout} unit="trades" testId="years-breakout" />}
      <YearColumns title="Daily traders, all together" years={traders} unit="setups" testId="years-traders" />
    </Card>
  );
};
