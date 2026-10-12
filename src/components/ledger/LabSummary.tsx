import React from "react";
import { Card } from "./ui";
import { edgePaused, recordSpan, rSigned, type EdgeTable } from "./LedgerBreakdown";
import { useLabFeed } from "./labFeed";
import { LabChip, type LabStatus } from "./labUi";
import { isDailyCoinsView, type DailyCoinsView } from "./DailyCoinsCard";
import { isMlTestView } from "./MlTestCard";

// The Lab's answers first: what's trading now and why (the Today tab). The
// details stay in the cards below it; every strategy's record side by side is
// on Records (StrategyRecords in LabDesk.tsx).

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
  const row = "w-full min-h-14 flex items-center gap-2.5 py-2.5 text-left border-b border-line last:border-b-0";
  return onOpen ? (
    <button type="button" onClick={onOpen} className={`${row} cursor-pointer`}>
      {body}
    </button>
  ) : (
    <div className={row}>{body}</div>
  );
};

/** The Today tab's card under the deck of strategies: the other traders and the tests, whether each is on, and the record that decides. */
export const LabSummary: React.FC<{ onOpen?: (tab: LabTab) => void }> = ({ onOpen }) => {
  const dc = useLabFeed("/api/daily-coins", isDailyCoinsView);
  const edge = useLabFeed("/api/scanner/exit-edge", isEdgeView);
  const ml = useLabFeed("/api/ml-test", isMlTestView);
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
  // Coin, US and funds breakout and US momentum are the deck of strategies above (StrategyLineup).
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
    <Card aria-label="Other traders and tests" className="flex flex-col">
      <h2 className="m-0 mb-1 text-sm font-semibold">Other traders and tests</h2>
      <div className="flex flex-col" data-testid="lab-summary">
        {rows}
      </div>
    </Card>
  );
};
