import React, { useEffect, useState } from "react";
import { apiFetch } from "../../services/apiClient";
import { FIXED_COINS, historyRows, profileTotals, recordStats, sumRecords, type HistoryRecords, type MarketTotals, type Timeframe } from "../../services/historyReplay";
import { MARKET_KINDS, type MarketKind, type TraderRecord } from "../../services/exitExpectancy";
import { isNseSymbol } from "../../shared/nse";
import { isUsSymbol } from "../../shared/usMarket";
import { DEFAULT_TRAIL_PROFILE, TRAIL_PROFILES, type TrailProfileId } from "../../shared/trailingStop";
import { Card } from "./ui";
import { pnlTone } from "./format";
import { MARKET_TAB, MARKET_TITLE, rSigned } from "./LedgerBreakdown";

// The traders over the last two years: the server replays every market's
// 5-minute history in the background (server/history/historyJob.ts) and
// this shows how far it has got and what each trader made, half-year by
// half-year, plus how each exit profile did on the same setups.

type Phase = "idle" | "starting" | "downloading" | "replaying" | "waiting_for_nse";

export interface HistoryView {
  running: boolean;
  phase: Phase;
  current: string | null;
  finished: number;
  total: number;
  run: {
    startedAt: number;
    finishedAt: number | null;
    fromMs: number;
    toMs: number;
    markets: Record<MarketKind, { done: number; failed: number; skipped: number }>;
    /** Every setup saved with its readings and results (for machine learning). */
    setups?: { count: number; bytes: number; full: boolean };
    problems: { symbol: string; note: string }[];
  } | null;
  records: HistoryRecords;
  /** The same on slower candles (absent from servers before them). */
  slow?: Partial<Record<Timeframe, HistoryRecords>>;
  /** Each market's own slower results, every trader together (the coin check). */
  slowByMarket?: Record<string, MarketTotals>;
}

type CardTimeframe = "5m" | Timeframe;
const TIMEFRAME_TAB: Record<CardTimeframe, string> = { "5m": "5 min", "1h": "1 hour", "1d": "1 day" };
/** How each timeframe's trades are held, in a sentence. */
const TIMEFRAME_RULE: Record<CardTimeframe, string> = {
  "5m": "As the desk trades today: 5-minute candles, stocks closed the same day.",
  "1h": "Slower: hourly candles, stops sized on them (wider), held up to 5 days, overnight included (Indian stocks as delivery trades, at about 0.5% a round trip).",
  "1d": "Slowest: daily candles, stops sized on them (wider still), held up to 30 days (Indian stocks as delivery trades). The first months warm the indicators up, so it covers about the last year.",
};

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  starting: "starting",
  downloading: "downloading",
  replaying: "replaying",
  waiting_for_nse: "waiting for NSE to close",
};
/** While a run is going, look again this often. */
const RUNNING_REFRESH_MS = 60_000;

const kindOf = (symbol: string): MarketKind => (isUsSymbol(symbol) ? "us" : isNseSymbol(symbol) ? "nse" : "crypto");
const shortName = (symbol: string) => symbol.replace(/\/INR$|\.US$/, "");

/** A group's or market's figures, as the exit profiles show theirs (`brief`: without the share won, to fit a phone's line). */
const Figures: React.FC<{ rec: TraderRecord; brief?: boolean }> = ({ rec, brief }) => {
  const stats = recordStats(rec);
  return (
    <span className="text-muted ml-auto">
      {stats.trades} setups · {brief ? "" : `${stats.winPct}% won · `}
      <span className={`font-semibold ${pnlTone(stats.avgR)}`}>{rSigned(stats.avgR)}</span>
    </span>
  );
};

/** A reply this card can show (an older server, or an error, has no results). */
const isView = (body: any): body is HistoryView => !!body && typeof body.records === "object" && body.records !== null && typeof body.running === "boolean";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export const HistoryCard: React.FC<{ trailProfile?: TrailProfileId }> = ({ trailProfile }) => {
  const profile = trailProfile ?? DEFAULT_TRAIL_PROFILE;
  const [view, setView] = useState<HistoryView | null>(null);
  const [market, setMarket] = useState<MarketKind>("crypto");
  const [timeframe, setTimeframe] = useState<CardTimeframe>("5m");
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      apiFetch("/api/history")
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
  }, [restarting]);

  const replayAgain = () => {
    setRestarting(true);
    apiFetch("/api/history/run", { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => isView(body) && setView(body))
      .catch(() => {})
      .finally(() => setRestarting(false));
  };

  if (!view) return null;
  const records = timeframe === "5m" ? view.records : view.slow?.[timeframe] ?? {};
  const { halves, rows } = historyRows(records, profile);
  const shown = rows.filter((r) => r.market === market);
  const exits = profileTotals(records).filter((t) => t.market === market);
  const counts = view.run?.markets;
  // Each market's own result on the slower candles, best first; the coins split into the fixed list and today's picks.
  const each =
    timeframe === "5m"
      ? []
      : Object.entries(view.slowByMarket ?? {})
          .filter(([symbol]) => kindOf(symbol) === market)
          .flatMap(([symbol, totals]) => {
            const rec = totals[timeframe]?.[profile];
            return rec && rec.trades > 0 ? [{ symbol, rec, fixed: FIXED_COINS.includes(symbol) }] : [];
          })
          .sort((a, b) => b.rec.totalR / b.rec.trades - a.rec.totalR / a.rec.trades);
  const coinGroups = [
    { label: "Fixed list", list: each.filter((e) => e.fixed) },
    { label: "Today's picks", list: each.filter((e) => !e.fixed) },
  ].filter((g) => g.list.length > 0);

  return (
    <Card aria-label="Traders over two years" className="flex flex-col gap-1">
      <div className="text-sm font-semibold">Traders over two years</div>
      <div className="text-xs text-muted leading-relaxed">
        Every trader's setups on the last two years of candles, played out with your {TRAIL_PROFILES[profile].label.toLowerCase()} trailing
        stop, the half banked at +1R and the time limit, after fees and spreads, one at a time. Coins use Binance's history (in dollars:
        results in R come out the same), charged their CoinDCX spread up to 0.2%, the most the desk trades at. It runs on the server in the
        background, slowly so live scanning isn't slowed: about half a day, then again each week.
      </div>

      <div className="text-xs tabular-nums mt-1" data-testid="history-status">
        {view.running ? (
          <span className="text-ink">
            Replaying: {view.finished} of {view.total} markets checked
            {view.current && ` · ${PHASE_LABEL[view.phase] || "on"} ${view.current}`}
          </span>
        ) : view.run?.finishedAt ? (
          <span className="text-muted">
            {day(view.run.fromMs)} – {day(view.run.toMs)} · updated {day(view.run.finishedAt)}
          </span>
        ) : (
          <span className="text-muted">Starts a few minutes after the server does.</span>
        )}
      </div>

      {view.run?.setups && view.run.setups.count > 0 && (
        <div className="text-xs text-muted tabular-nums" data-testid="history-setups">
          Setup details saved for machine learning: {view.run.setups.count.toLocaleString("en-IN")} setups (
          {(view.run.setups.bytes / 1024 / 1024).toFixed(1)} MB){view.run.setups.full ? ", the most kept: later markets' aren't saved" : ""}
        </div>
      )}

      <div role="tablist" aria-label="Candles" className="grid grid-cols-3 mt-2 p-0.5 rounded-full bg-inset border border-line">
        {(["5m", "1h", "1d"] as const).map((tf) => (
          <button
            key={tf}
            type="button"
            role="tab"
            aria-selected={tf === timeframe}
            onClick={() => setTimeframe(tf)}
            className={`min-h-9 rounded-full text-[13px] font-semibold cursor-pointer transition-colors ${tf === timeframe ? "bg-accent text-on-accent" : "text-muted"}`}
          >
            {TIMEFRAME_TAB[tf]}
          </button>
        ))}
      </div>
      <div className="text-xs text-muted" data-testid="history-timeframe">
        {TIMEFRAME_RULE[timeframe]}
      </div>

      <div role="tablist" aria-label="Market" className="grid grid-cols-3 mt-2 p-0.5 rounded-full bg-inset border border-line">
        {MARKET_KINDS.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={m === market}
            onClick={() => setMarket(m)}
            className={`min-h-9 rounded-full text-[13px] font-semibold cursor-pointer transition-colors ${m === market ? "bg-accent text-on-accent" : "text-muted"}`}
          >
            {MARKET_TAB[m]}
            {counts ? ` · ${counts[m].done}` : ""}
          </button>
        ))}
      </div>

      <div className="text-xs font-semibold text-muted mt-2">{MARKET_TITLE[market]}</div>
      {shown.length === 0 ? (
        <div className="text-xs text-muted">{view.running ? "No results here yet." : "No results here."}</div>
      ) : (
        <>
          {/* Each half-year's average, oldest first: a trader who only did well once shows it. */}
          <div className="grid gap-1 text-[10px] text-muted mt-1" style={{ gridTemplateColumns: `repeat(${halves.length}, minmax(0, 1fr))` }}>
            {halves.map((h) => (
              <span key={h} className="text-center truncate">{h}</span>
            ))}
          </div>
          <ul className="m-0 p-0 list-none flex flex-col" data-testid="history-traders">
            {shown.map((r) => (
              <li key={r.trader} className="py-2 border-b border-line last:border-b-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm truncate">{r.trader}</div>
                    <div className="text-xs text-muted tabular-nums">
                      {r.trades} setups · {r.winPct}% won · win {rSigned(r.avgWinR)} · loss {rSigned(r.avgLossR)}
                    </div>
                  </div>
                  <span className={`shrink-0 text-sm font-semibold tabular-nums ${pnlTone(r.avgR)}`}>{rSigned(r.avgR)}</span>
                </div>
                <div className="grid gap-1 mt-1.5" style={{ gridTemplateColumns: `repeat(${halves.length}, minmax(0, 1fr))` }}>
                  {r.halves.map((h, k) => (
                    <span
                      key={k}
                      title={`${halves[k]}: ${h.trades} setups`}
                      className={`text-center text-[11px] tabular-nums rounded-md bg-inset py-0.5 ${h.avgR === null ? "text-muted" : pnlTone(h.avgR)}`}
                    >
                      {h.avgR === null ? "—" : rSigned(h.avgR).replace("R", "")}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {exits.length > 0 && (
        <div className="mt-2 p-2.5 rounded-xl bg-inset flex flex-col gap-1.5" data-testid="history-exits">
          <div className="text-[11px] font-semibold text-muted">Every trader here, by trailing stop (the same setups)</div>
          {exits.map(({ profile: p, stats }) => (
            <div key={p} className="flex items-center justify-between gap-2 text-xs tabular-nums">
              <span className={p === profile ? "font-semibold" : "text-muted"}>
                {TRAIL_PROFILES[p].label}
                {p === profile ? " (yours)" : ""}
              </span>
              <span className="text-muted">
                {stats.trades} setups · {stats.winPct}% won ·{" "}
                <span className={`font-semibold ${pnlTone(stats.avgR)}`}>{rSigned(stats.avgR)}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {each.length > 0 && (
        <div className="mt-2 p-2.5 rounded-xl bg-inset flex flex-col gap-1.5" data-testid="history-markets">
          {market === "crypto" && (
            <>
              <div className="text-[11px] font-semibold text-muted">Coin check: a list fixed in advance against today's picks</div>
              <div className="text-[11px] text-muted leading-relaxed">
                Today's picks are the coins most active now, which can favour coins that rose. The fixed list is the {FIXED_COINS.length} biggest coins
                on 1 Oct 2024, picked before the two years began. If the traders only do well on today's picks, the coins did the work.
              </div>
              {coinGroups.map((g) => (
                <div key={g.label} className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums">
                  <span className="font-semibold">
                    {g.label} · {g.list.length} {g.list.length === 1 ? "coin" : "coins"}
                  </span>
                  <Figures rec={sumRecords(g.list.map((e) => e.rec))} />
                </div>
              ))}
            </>
          )}
          <details>
            <summary className="text-[11px] font-semibold text-muted cursor-pointer">
              Each {market === "crypto" ? "coin" : "stock"} ({each.length})
            </summary>
            <ul className="m-0 p-0 list-none flex flex-col mt-1">
              {each.map((e) => (
                <li key={e.symbol} className="flex flex-wrap items-baseline justify-between gap-x-2 py-1 text-xs tabular-nums">
                  <span className="min-w-0">
                    {shortName(e.symbol)}
                    {market === "crypto" && e.fixed && (
                      <span className="ml-1.5 px-1.5 rounded-full border border-line text-[10px] text-muted align-middle">fixed list</span>
                    )}
                  </span>
                  <Figures rec={e.rec} brief />
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {view.run && view.run.problems.length > 0 && (
        <div className="text-[11px] text-muted mt-1">
          Not replayed: {view.run.problems.map((p) => `${p.symbol} (${p.note})`).join(", ")}.
        </div>
      )}

      {!view.running && (
        <button
          type="button"
          onClick={replayAgain}
          disabled={restarting}
          className="self-start mt-2 min-h-9 px-3.5 rounded-full border border-line text-[13px] font-semibold cursor-pointer disabled:opacity-50"
        >
          Replay again
        </button>
      )}
    </Card>
  );
};
