import React, { useEffect, useState } from "react";
import { apiFetch } from "../../services/apiClient";
import { MARKETS, MIN_TEST_TRADES, type MarketVerdict } from "../../services/setupModel";
import type { MarketKind } from "../../services/exitExpectancy";
import { MIN_EDGE_R } from "../../services/calibration";
import { Card } from "./ui";
import { pnlTone } from "./format";
import { MARKET_TITLE, rSigned } from "./LedgerBreakdown";

// The machine-learning test (server/history/mlTest.ts): a model learns from
// the two-year replay's older months and is judged on the latest six, which
// it never saw. It decides nothing live.

export interface MlTestView {
  running: boolean;
  phase: "idle" | "reading" | "training" | "judging";
  trees: number;
  error: string | null;
  ready: boolean;
  result: {
    ranAt: number;
    profile: string;
    periods: { trainFrom: number; validFrom: number; testFrom: number; testTo: number };
    setups: { train: number; trainUsed: number; valid: number; test: number };
    trees: number;
    importance: { label: string; share: number }[];
    markets: Record<MarketKind, MarketVerdict | null>;
  } | null;
}

const RUNNING_REFRESH_MS = 30_000;
const isView = (body: any): body is MlTestView => !!body && typeof body.running === "boolean" && "result" in body;
const month = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
/** "Oct 2024 – Dec 2025": a period's first month to the month before `toMs`. */
const span = (fromMs: number, toMs: number) => `${month(fromMs)} – ${month(toMs - 1)}`;
const count = (n: number) => n.toLocaleString("en-IN");

export const MlTestCard: React.FC = () => {
  const [view, setView] = useState<MlTestView | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      apiFetch("/api/ml-test")
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
  }, [starting]);

  const run = () => {
    setStarting(true);
    apiFetch("/api/ml-test/run", { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => isView(body) && setView(body))
      .catch(() => {})
      .finally(() => setStarting(false));
  };

  if (!view) return null;
  const r = view.result;
  return (
    <Card aria-label="Machine-learning test" className="flex flex-col gap-1">
      <div className="text-sm font-semibold">Machine-learning test</div>
      <div className="text-xs text-muted leading-relaxed">
        A model learns from the two-year replay's setups: what was known when each came (its readings, the trader, the market, the time)
        against how it ended. It learns from the older months, is tuned on the next three, and is judged only on the latest six, which it
        never saw. It passes in a market only if its picks, traded one at a time, average at least {rSigned(MIN_EDGE_R)} after costs, clearly
        above zero, over {MIN_TEST_TRADES}+ trades. It decides nothing live.
      </div>

      <div className="text-xs tabular-nums mt-1" data-testid="ml-status">
        {view.running ? (
          <span className="text-ink">
            {view.phase === "training" ? `Training: ${view.trees} trees so far` : view.phase === "judging" ? "Judging on the latest months" : "Reading the saved setups"}
            {" · it rests between steps, so it takes a while"}
          </span>
        ) : view.error ? (
          <span className="text-loss">Couldn't run: {view.error}</span>
        ) : r ? (
          <span className="text-muted">
            Learned from {span(r.periods.trainFrom, r.periods.validFrom)} ({count(r.setups.trainUsed)} setups), tuned on{" "}
            {span(r.periods.validFrom, r.periods.testFrom)}, judged on {span(r.periods.testFrom, r.periods.testTo)} ({count(r.setups.test)} setups).
          </span>
        ) : (
          <span className="text-muted">{view.ready ? "Ready to run." : "Waits for the two-year replay to finish."}</span>
        )}
      </div>

      {r && (
        <ul className="m-0 p-0 list-none flex flex-col" data-testid="ml-markets">
          {MARKETS.map((m) => {
            const v = r.markets[m];
            if (!v) return null;
            return (
              <li key={m} className="py-2 border-b border-line last:border-b-0 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">{MARKET_TITLE[m]}</span>
                  <span className={`text-xs font-semibold ${v.passed ? "text-gain" : "text-loss"}`}>{v.passed ? "Passes" : "Doesn't pass"}</span>
                </div>
                <div className="text-xs text-muted tabular-nums">
                  Every setup: <span className={pnlTone(v.everySetup.avgR)}>{rSigned(v.everySetup.avgR)}</span> over {count(v.everySetup.trades)} trades
                </div>
                <div className="text-xs text-muted tabular-nums">
                  {v.share >= 1 ? "Its picks (all of them)" : `Its picks (the best ${Math.round(v.share * 100)}%)`}:{" "}
                  <span className={`font-semibold ${pnlTone(v.picks.avgR)}`}>{rSigned(v.picks.avgR)}</span> over {count(v.picks.trades)} trades ·{" "}
                  {v.picks.winPct}% won · at worst about {rSigned(v.picks.lowR)}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {r && r.importance.length > 0 && (
        <div className="text-[11px] text-muted mt-1" data-testid="ml-importance">
          What it relied on most: {r.importance.map((x) => `${x.label} ${Math.round(x.share * 100)}%`).join(", ")}.
        </div>
      )}

      {!view.running && view.ready && (
        <button
          type="button"
          onClick={run}
          disabled={starting}
          className="self-start mt-2 min-h-9 px-3.5 rounded-full border border-line text-[13px] font-semibold cursor-pointer disabled:opacity-50"
        >
          {r ? "Run again" : "Run the test"}
        </button>
      )}
    </Card>
  );
};
