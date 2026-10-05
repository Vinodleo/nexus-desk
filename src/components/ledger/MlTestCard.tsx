import React, { useEffect, useState } from "react";
import { apiFetch } from "../../services/apiClient";
import { labGet } from "./labFeed";
import { CompareBars, Fold, LabChip } from "./labUi";
import { MARKETS, MIN_TEST_TRADES, type MarketVerdict } from "../../services/setupModel";
import type { MarketKind } from "../../services/exitExpectancy";
import { MIN_EDGE_R } from "../../services/calibration";
import { Card } from "./ui";
import { pnlTone } from "./format";
import { MARKET_TAB, MARKET_TITLE, rSigned } from "./LedgerBreakdown";
import type { BreakoutMlVerdict } from "../../services/breakoutModel";

// The machine-learning test (server/history/mlTest.ts): a model learns from
// replayed setups' older periods and is judged on the latest, which it never
// saw. Three tests: the daily coin trades since 2017 (judged on the latest
// year), breakout 55/20's and momentum's trades on coins and US stocks
// (judged year by year: whether skipping the least promising half adds
// profit), and the two-year replay's 5-minute trades (the latest six
// months). It decides nothing live.

type MlResult = {
  ranAt: number;
  profile: string;
  periods: { trainFrom: number; validFrom: number; testFrom: number; testTo: number };
  setups: { train: number; trainUsed: number; valid: number; test: number };
  trees: number;
  importance: { label: string; share: number }[];
  markets: Record<MarketKind, MarketVerdict | null>;
};

export interface MlTestView {
  running: boolean;
  phase: "idle" | "reading" | "training" | "judging";
  trees: number;
  error: string | null;
  ready: boolean;
  /** The 5-minute test's verdict. */
  result: MlResult | null;
  /** Which test is running (absent from older servers). */
  testing?: "5m" | "daily" | "breakout" | null;
  /** The daily coin test (absent from older servers). */
  daily?: { ready: boolean; result: MlResult | null };
  /** The test on breakout trades, with momentum's (absent from older servers). */
  breakout?: { ready: boolean; result: BreakoutResult | null };
}

type BreakoutVerdict = Pick<BreakoutMlVerdict, "fromYear" | "toYear" | "every" | "picks" | "skipped" | "importance" | "passed">;
type SlowMarket = "coins" | "us" | "funds";
/** The funds (gold, bonds and the rest) are absent from older servers' verdicts. */
type SlowResult = { savedAt?: Partial<Record<SlowMarket, number | null>>; markets: Partial<Record<SlowMarket, BreakoutVerdict | null>> };
type BreakoutResult = SlowResult & { ranAt: number; momentum?: SlowResult };
const SLOW_MARKETS: SlowMarket[] = ["coins", "us", "funds"];
const BREAKOUT_MARKET_TITLE: Record<SlowMarket, string> = { coins: "Coins", us: "US stocks", funds: "Gold, bond and other funds" };
const STRATEGY = {
  breakout: { title: "Breakout trades", trades: "breakout trades", notTraded: { funds: true } as Partial<Record<SlowMarket, boolean>> },
  // Coins don't trade momentum (your call: +0.11R a trade since 2018, well behind breakout), and the funds trade nothing yet: their tests are shown, marked.
  momentum: { title: "Momentum trades (top 3)", trades: "momentum trades", notTraded: { coins: true, funds: true } as Partial<Record<SlowMarket, boolean>> },
} as const;

/** Each market's verdict on a strategy's trades: every trade against the model's picks and the trades it would skip. */
const SlowVerdicts: React.FC<{ strategy: keyof typeof STRATEGY; ready: boolean; result: SlowResult | null }> = ({ strategy, ready, result: r }) => {
  const markets = r ? SLOW_MARKETS.flatMap((m) => (r.markets[m] ? [{ market: m, v: r.markets[m]! }] : [])) : [];
  // Judged with none of this strategy's trades saved yet: it waits for the replays.
  const saved = !r?.savedAt || Object.values(r.savedAt).some((at) => at !== null);
  const { title, trades, notTraded } = STRATEGY[strategy];
  return (
    <div className="flex flex-col gap-1.5" data-testid={`ml-${strategy}`}>
      <div className="text-[11px] font-semibold text-muted">{title}: would skipping its least promising half add profit?</div>
      {markets.length === 0 ? (
        <div className="text-xs text-muted" data-testid={`ml-${strategy}-status`}>
          {r && saved ? `Too few years of ${trades} to judge yet.` : !r && ready ? "Ready to run." : `Waits for the replays to save their ${trades}.`}
        </div>
      ) : (
        markets.map(({ market, v }) => (
          <div key={market} className="flex flex-col gap-1" data-testid={`ml-${strategy}-${market}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold">
                {BREAKOUT_MARKET_TITLE[market]}
                {notTraded[market] ? " (not traded)" : ""}{" "}
                <span className="font-normal text-muted tabular-nums">judged {v.fromYear}–{v.toYear}</span>
              </span>
              <LabChip status={v.passed ? "passes" : "fails"}>{v.passed ? "Passes" : "Doesn't pass"}</LabChip>
            </div>
            <CompareBars
              rows={[
                { label: "Every trade", sub: `${count(v.every.trades)} trades`, r: v.every.avgR },
                { label: "Its picks", sub: `${count(v.picks.trades)} trades`, r: v.picks.avgR, strong: true },
                { label: "Skipped", sub: `${count(v.skipped.trades)} trades`, r: v.skipped.avgR },
              ]}
            />
            <div className="text-[11px] text-muted leading-snug">
              {v.passed
                ? "The trades it skips clearly lost: skipping them would add profit."
                : v.skipped.avgR > 0
                  ? `The trades it skips still made ${rSigned(v.skipped.avgR)} a trade: skipping them would cost profit.`
                  : "The trades it skips lost, but not by more than luck could explain."}
            </div>
          </div>
        ))
      )}
    </div>
  );
};

const RUNNING_REFRESH_MS = 30_000;
export const isMlTestView = (body: any): body is MlTestView => !!body && typeof body.running === "boolean" && "result" in body;
const month = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
/** "Oct 2024 – Dec 2025": a period's first month to the month before `toMs`. */
const span = (fromMs: number, toMs: number) => `${month(fromMs)} – ${month(toMs - 1)}`;
const count = (n: number) => n.toLocaleString("en-IN");
/** What a result learned from, was tuned on and was judged on. */
const periodsText = (r: MlResult) =>
  `Learned from ${span(r.periods.trainFrom, r.periods.validFrom)} (${count(r.setups.trainUsed)} setups), tuned on ${span(r.periods.validFrom, r.periods.testFrom)}, judged on ${span(r.periods.testFrom, r.periods.testTo)} (${count(r.setups.test)} setups).`;

/** Each market's verdict, and what the model relied on. */
const Verdicts: React.FC<{ r: MlResult; testId: string }> = ({ r, testId }) => (
  <>
    <ul className="m-0 p-0 list-none flex flex-col" data-testid={`${testId}-markets`}>
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
    {r.importance.length > 0 && (
      <div className="text-[11px] text-muted mt-1" data-testid={`${testId}-importance`}>
        What it relied on most: {r.importance.map((x) => `${x.label} ${Math.round(x.share * 100)}%`).join(", ")}.
      </div>
    )}
  </>
);

export const MlTestCard: React.FC = () => {
  const [view, setView] = useState<MlTestView | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      labGet("/api/ml-test")
        .then((body) => {
          if (cancelled || !isMlTestView(body)) return;
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
      .then((body) => isMlTestView(body) && setView(body))
      .catch(() => {})
      .finally(() => setStarting(false));
  };

  if (!view) return null;
  const r = view.result;
  const daily = view.daily;
  const breakout = view.breakout;
  const coins = daily?.result?.markets.crypto ?? null;
  const fiveMinute = r ? MARKETS.flatMap((m) => (r.markets[m] ? [{ market: m, v: r.markets[m]! }] : [])) : [];
  return (
    <Card aria-label="Machine-learning test" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold">Machine-learning filter</div>
        {coins && <LabChip status={coins.passed ? "passes" : "fails"}>{coins.passed ? "Passes" : "Doesn't pass"}</LabChip>}
      </div>
      {coins && (
        <>
          <div className="text-xs text-muted leading-snug" data-testid="ml-verdict">
            Can a model pick the better daily coin setups? On the latest year, which it never saw, its picks averaged{" "}
            {rSigned(coins.picks.avgR)} a trade against {rSigned(coins.everySetup.avgR)} for every setup. It decides nothing live.
          </div>
          <CompareBars
            testId="ml-compare"
            rows={[
              { label: "Every setup", sub: `${count(coins.everySetup.trades)} trades`, r: coins.everySetup.avgR },
              { label: "Its picks", sub: `${count(coins.picks.trades)} trades`, r: coins.picks.avgR, strong: true },
            ]}
          />
        </>
      )}
      {breakout && <SlowVerdicts strategy="breakout" ready={breakout.ready} result={breakout.result} />}
      {/* A verdict from before momentum was tested: the test runs again once the replays save its trades. */}
      {breakout && <SlowVerdicts strategy="momentum" ready={breakout.ready && !breakout.result} result={breakout.result?.momentum ?? null} />}
      {fiveMinute.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] font-semibold text-muted">5-minute trades over two years, its picks</div>
          <div className="flex gap-2" data-testid="ml-five-minute">
            {fiveMinute.map(({ market, v }) => (
              <div key={market} className="flex-1 basis-0 min-w-0 bg-inset rounded-[10px] px-2.5 py-2">
                <div className="text-[11px] text-muted">{MARKET_TAB[market]}</div>
                <div className="text-sm font-semibold tabular-nums">{rSigned(v.picks.avgR)}</div>
                <LabChip status={v.passed ? "passes" : "fails"}>{v.passed ? "Passes" : "No"}</LabChip>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-xs tabular-nums empty:hidden" data-testid="ml-progress">
        {view.running ? (
          <span className="text-ink">
            {view.testing === "daily" ? "Daily coins: " : view.testing === "5m" ? "5-minute trades: " : view.testing === "breakout" ? "Breakout and momentum trades: " : ""}
            {view.phase === "training"
              ? `Training: ${view.trees} trees so far`
              : view.phase === "judging"
                ? view.testing === "breakout"
                  ? "Judging year by year"
                  : "Judging on the latest months"
                : "Reading the saved setups"}
            {" · it rests between steps, so it takes a while"}
          </span>
        ) : view.error ? (
          <span className="text-loss">Couldn't run: {view.error}</span>
        ) : null}
      </div>

      <Fold title="Details">
        {daily && (
          <div className="flex flex-col gap-1" data-testid="ml-daily">
            <div className="text-xs font-semibold text-muted">Daily coin trades since 2017</div>
            <div className="text-xs text-muted tabular-nums" data-testid="ml-daily-status">
              {daily.result ? periodsText(daily.result) : daily.ready ? "Ready to run." : "Waits for the replay since 2017 to finish."}
            </div>
            {daily.result && <Verdicts r={daily.result} testId="ml-daily" />}
          </div>
        )}
        <div className="flex flex-col gap-1">
          {daily && <div className="text-xs font-semibold text-muted">5-minute trades over two years</div>}
          <div className="text-xs text-muted tabular-nums" data-testid="ml-status">
            {r ? periodsText(r) : view.ready ? "Ready to run." : "Waits for the two-year replay to finish."}
          </div>
          {r && <Verdicts r={r} testId="ml" />}
        </div>
      </Fold>

      <Fold title="How the test works">
        <div className="text-xs text-muted leading-relaxed">
          A model learns from replayed setups: what was known when each came (its readings, the trader, the market, the time) against how
          it ended. It learns from the older part, is tuned on the next, and is judged only on the latest, which it never saw: for daily coin
          trades since 2017 the latest year, for the two-year replay's 5-minute trades the latest six months. It passes in a market only if
          its picks, traded one at a time, average at least {rSigned(MIN_EDGE_R)} after costs, clearly above zero, over {MIN_TEST_TRADES}+
          trades. It decides nothing live.
        </div>
        <div className="text-xs text-muted leading-relaxed mt-1.5">
          Breakout and momentum trades (on coins, US stocks, and funds of gold, bonds and the rest) are fewer (a few hundred per market), so
          they're judged year by year: for each year from the fifth on,
          a model learns from the years before but the last, the last sets how choosy it is (the middle of its predictions), and that year's
          trades are judged, never seen. It reads each trade at its entry: how far past the 55-day high, its rises over 20 and 90 days, its
          volatility and volume, its day, and the market's trend. Their profit comes mostly from a few big winners, so a filter helps only if
          the trades it skips lose money. It passes only if they clearly did, its picks {rSigned(MIN_EDGE_R)}+ ahead of every trade.
        </div>
      </Fold>

      {!view.running && (view.ready || daily?.ready || breakout?.ready) && (
        <button
          type="button"
          onClick={run}
          disabled={starting}
          className="self-start min-h-9 px-3.5 rounded-full border border-line text-[13px] font-semibold cursor-pointer disabled:opacity-50"
        >
          {r || daily?.result || breakout?.result ? "Run again" : "Run the test"}
        </button>
      )}
    </Card>
  );
};
