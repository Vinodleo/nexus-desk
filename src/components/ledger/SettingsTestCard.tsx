import React, { useState } from "react";
import { COSTS_DOUBLED, type SettingsCell, type SettingsResult, type SettingsVerdict } from "../../services/settingsTest";
import { useLabFeed } from "./labFeed";
import { CompareBars, Fold, LabChip, type LabStatus } from "./labUi";
import { Card, Segmented } from "./ui";
import { rSigned } from "./LedgerBreakdown";
import { isDailyLongView } from "./DailyLongCard";
import { isStocksLongView } from "./StocksLongCard";

// The settings test (src/services/settingsTest.ts, run by the long replays):
// each strategy that trades replayed at settings around its own. A grid with
// its own settings in the middle, each cell what that setting made a trade;
// a tighter and a looser stop and double the costs below it; and the verdict:
// whether its record holds up nearby or leans on the exact settings.

type TestId = "coins-breakout" | "us-breakout" | "us-momentum" | "funds-breakout";

const TESTS: { id: TestId; label: string; title: string }[] = [
  { id: "coins-breakout", label: "Coins", title: "Coin breakout" },
  { id: "us-breakout", label: "US", title: "US breakout" },
  { id: "us-momentum", label: "Top 3", title: "US momentum" },
  { id: "funds-breakout", label: "Funds", title: "Funds breakout" },
];

const VERDICT: Record<SettingsVerdict, { status: LabStatus; label: string }> = {
  holds: { status: "passes", label: "Holds up" },
  mixed: { status: "paused", label: "Mixed" },
  fragile: { status: "fails", label: "Fragile" },
};

/** What the grid's rows and columns are, per strategy. */
const AXES = {
  breakout: { rows: "Buys above the high of", cols: "Sells below the low of", row: (n: number) => `${n} days`, col: (n: number) => `${n} days` },
  momentum: { rows: "Ranks the rise over", cols: "Holds the top", row: (n: number) => `${n} days`, col: (n: number) => `${n}` },
} as const;

const EXTRA_LABEL: Record<string, string> = {
  "stop-1.5": "Stop 1.5 ATR",
  "stop-3": "Stop 3 ATR",
  [COSTS_DOUBLED]: "Costs doubled",
};

/** The cell's tint: green for a setting that made money, red for one that lost, stronger the further from zero. */
function tint(cell: SettingsCell, scale: number): React.CSSProperties {
  if (cell.trades === 0) return {};
  const share = Math.round(12 + 30 * Math.min(1, Math.abs(cell.avgR) / scale));
  return { background: `color-mix(in srgb, var(--nx-${cell.avgR > 0 ? "gain" : "loss"}) ${share}%, transparent)` };
}

/** The verdict in a sentence, with what to expect: nearer the grid's average than its own record. */
export function verdictText(r: SettingsResult): string {
  const own = r.grid[Math.floor(r.grid.length / 2)];
  const nearby = r.grid.length - 1;
  const doubled = r.extra.find((c) => c.id === COSTS_DOUBLED);
  const across = `Across the grid: ${rSigned(r.nearbyAvgR)} a trade, against ${rSigned(own.avgR)} for its own settings.`;
  if (r.verdict === "holds") return `All ${nearby} nearby settings made money, and doubled costs still do. ${across} Expect nearer the grid's figure.`;
  if (doubled && doubled.avgR <= 0) return `Doubled costs turn it to a loss: its edge is thin for its costs. ${across}`;
  if (r.verdict === "fragile") return `Only ${r.nearbyUp} of ${nearby} nearby settings made money: its record likely leans on its exact settings. ${across}`;
  return `${r.nearbyUp} of ${nearby} nearby settings made money. ${across}`;
}

const cellLine = (label: string, c: SettingsCell) =>
  c.trades === 0 ? `${label}: no trades` : `${label}: ${c.trades} trades · ${c.winPct}% won · ${c.yearsUp} of ${c.years} years up · ${rSigned(c.avgR)} a trade`;

const SettingsGrid: React.FC<{ result: SettingsResult }> = ({ result: r }) => {
  const centre = Math.floor(r.grid.length / 2);
  const [picked, setPicked] = useState(centre);
  const axes = AXES[r.strategy];
  const scale = Math.max(0.2, ...r.grid.map((c) => Math.abs(c.avgR)));
  const label = (k: number) => `${axes.rows.toLowerCase()} ${axes.row(r.rows[Math.floor(k / r.cols.length)])}, ${axes.cols.toLowerCase()} ${axes.col(r.cols[k % r.cols.length])}`;
  const chosen = r.grid[picked] ?? r.grid[centre];
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[64px_repeat(3,minmax(0,1fr))] gap-1.5 text-[11px]" role="grid" aria-label="Settings tried">
        <span className="text-muted leading-tight self-end" aria-hidden="true">
          {axes.rows} ↓
        </span>
        {r.cols.map((c) => (
          <span key={c} className="text-center text-muted self-end leading-tight" role="columnheader">
            {axes.col(c)}
          </span>
        ))}
        {r.rows.map((row, i) => (
          <React.Fragment key={row}>
            <span className="text-muted self-center leading-tight" role="rowheader">
              {axes.row(row)}
            </span>
            {r.cols.map((_, j) => {
              const k = i * r.cols.length + j;
              const c = r.grid[k];
              const own = k === centre;
              return (
                <button
                  key={c.id}
                  type="button"
                  data-testid={`settings-cell-${c.id}`}
                  aria-label={`${label(k)}: ${c.trades === 0 ? "no trades" : rSigned(c.avgR)}${own ? " (its own settings)" : ""}`}
                  aria-pressed={k === picked}
                  onClick={() => setPicked(k)}
                  className={`min-h-[52px] rounded-xl flex flex-col items-center justify-center tabular-nums cursor-pointer border ${
                    own ? "border-ink border-2" : k === picked ? "border-accent" : "border-transparent"
                  } ${c.trades === 0 ? "bg-inset text-muted" : ""}`}
                  style={tint(c, scale)}
                >
                  <span className="text-[13px] font-semibold">{c.trades === 0 ? "–" : rSigned(c.avgR)}</span>
                  <span className="text-[10px] text-muted">{own ? "its own" : `${c.trades} trades`}</span>
                </button>
              );
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="text-[11px] text-muted text-right">{axes.cols} →</div>
      <p className="m-0 text-xs leading-relaxed" data-testid="settings-picked">
        {cellLine(picked === centre ? "Its own settings" : axes.row(r.rows[Math.floor(picked / r.cols.length)]) + " / " + axes.col(r.cols[picked % r.cols.length]), chosen)}
      </p>
    </div>
  );
};

/**
 * Whether breakout's and momentum's records hold up around their settings:
 * a strategy at a time (coins, US, momentum, funds), its grid, the extra
 * checks and the verdict.
 */
export const SettingsTestCard: React.FC = () => {
  const dl = useLabFeed("/api/daily-long", isDailyLongView);
  const sl = useLabFeed("/api/stocks-long", isStocksLongView);
  const results: Record<TestId, SettingsResult | undefined> = {
    "coins-breakout": dl?.settings?.breakout,
    "us-breakout": sl?.settings?.us?.breakout,
    "us-momentum": sl?.settings?.us?.momentum,
    "funds-breakout": sl?.settings?.funds?.breakout,
  };
  const [picked, setPicked] = useState<TestId>("coins-breakout");
  const test = TESTS.find((t) => t.id === picked)!;
  const result = results[picked];
  const running = picked === "coins-breakout" ? dl?.running : sl?.running;
  const own = result ? result.grid[Math.floor(result.grid.length / 2)] : null;

  return (
    <Card aria-label="Settings test" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold">Do the settings hold up?</h2>
        {result && <LabChip status={VERDICT[result.verdict].status}>{VERDICT[result.verdict].label}</LabChip>}
      </div>
      <p className="m-0 text-xs text-muted leading-relaxed">
        Each strategy replayed at settings around its own. One worth trusting still makes money nearby; one that only works at its exact
        settings was likely fitted to the past.
      </p>
      <Segmented
        label="Strategy"
        options={TESTS.map((t) => ({ id: t.id, label: t.label }))}
        value={picked}
        onChange={setPicked}
      />
      {result && own ? (
        <>
          <SettingsGrid key={picked} result={result} />
          <CompareBars
            testId="settings-extra"
            rows={[
              { label: "Its own settings", r: own.avgR, strong: true },
              ...result.extra.map((c) => ({ label: EXTRA_LABEL[c.id] ?? c.id, sub: `${c.trades} trades`, r: c.avgR })),
            ]}
          />
          <p className="m-0 text-[13px] leading-relaxed" data-testid="settings-verdict">
            {verdictText(result)}
          </p>
        </>
      ) : (
        <p className="m-0 text-[13px] text-muted leading-relaxed">
          {running
            ? `${test.title}: the replay is running; the test follows it.`
            : `${test.title}: runs with its next replay (coins from the kept candles; stocks and funds with the stocks' replay).`}
        </p>
      )}
      <Fold title="How the test works">
        <p className="m-0 text-xs text-muted leading-relaxed">
          Each strategy is replayed on the same candles, yearly lists and costs as its long replay (coins since 2018, stocks and funds
          since 2016), at a 3 by 3 grid of settings with its own in the middle: breakout buying above a 40, 55 or 70-day high and selling
          below a 15, 20 or 30-day low; momentum ranking the rise over 60, 90 or 120 days and holding the top 2, 3 or 5. Breakout also
          tries a stop 1.5 and 3 ATR below the entry, and each its own settings at double the costs.
        </p>
        <p className="m-0 text-xs text-muted leading-relaxed">
          Holds up: every nearby setting made money and doubled costs still do. Fragile: most nearby settings lost, or doubled costs lose.
          Mixed: in between. The grid's average is the fairer guide to what it may make. It decides nothing: what trades is still each
          strategy's own record.
        </p>
      </Fold>
    </Card>
  );
};
