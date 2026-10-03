import React from "react";
import { Card } from "./ui";
import { pnlTone } from "./format";
import { rSigned } from "./LedgerBreakdown";
import { useLabFeed } from "./labFeed";
import { Fold } from "./labUi";

// Coin trades on daily candles (server/scanner/dailyCoins.ts): the server's
// check once a day, what it found and did, how many coin slots are in use,
// and which traders trade (their daily record decides: since 2017 once that
// replay has finished, else over the last two years), with breakout 55/20
// alongside (its record since 2018 decides). Paper only.

export interface DailyCoinsView {
  run: {
    at: number;
    day: string;
    coins: number;
    failed: string[];
    picks: { symbol: string; trader: string; outcome: "opened" | "sold" | "waiting" | "paused"; reason?: string }[];
    note?: string;
  } | null;
  traders: { trader: string; trades: number; avgR: number; on: boolean }[];
  /** The years the traders' records cover, in words ("since 2017"); absent from older servers (two years). */
  recordSpan?: string | null;
  /** Breakout 55/20's record since 2018 and whether it trades; null before it has run, absent from older servers. */
  breakout?: { trader: string; trades: number; avgR: number; on: boolean } | null;
  /** Coin trades open now against the coin limit; null before the app has sent its settings, absent from older servers. */
  coinSlots?: { used: number; max: number } | null;
  nextAt: number;
}

/** A reply this card can show (an older server has no such route). */
export const isDailyCoinsView = (body: any): body is DailyCoinsView => !!body && Array.isArray(body.traders) && typeof body.nextAt === "number";

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** Each outcome's word, sign and colour: the sign says it as well as the colour. */
const OUTCOME = {
  opened: { label: "opened", icon: "↑", tone: "text-gain" },
  sold: { label: "sold", icon: "↓", tone: "text-accent" },
  waiting: { label: "not opened", icon: "○", tone: "text-warn" },
  paused: { label: "paused", icon: "‖", tone: "text-muted" },
} as const;

/** The autopilot's reason when the coin limit was full. */
const NO_FREE_SLOT = /open coin trades? at once/;
const coin = (symbol: string) => symbol.replace(/\/INR$/, "");

/** Coin trades open now against the limit, and which of the day's setups waited for a slot. */
const CoinSlots: React.FC<{ used: number; max: number; waited: string[] }> = ({ used, max, waited }) => {
  const segments = Math.min(max, 12);
  const width = segments <= 4 ? "w-6" : segments <= 8 ? "w-3.5" : "w-2";
  return (
    <div className="p-2.5 rounded-xl bg-inset flex items-center gap-3" data-testid="daily-slots">
      <div className="flex gap-1 shrink-0" aria-hidden="true">
        {Array.from({ length: segments }, (_, k) => (
          <span key={k} className={`${width} h-2.5 rounded-full ${k < used ? "bg-accent" : "bg-surface border border-line"}`} />
        ))}
      </div>
      <div className="text-xs leading-snug min-w-0">
        <span className="font-semibold tabular-nums">
          Coin slots: {Math.min(used, max)} of {max} in use
        </span>
        {waited.length > 0 && (
          <span className="block text-muted">
            {waited.map(coin).join(", ")} waited for a free slot. To take more, raise Settings → Coins: trades at once.
          </span>
        )}
      </div>
    </div>
  );
};

export const DailyCoinsCard: React.FC = () => {
  const view = useLabFeed("/api/daily-coins", isDailyCoinsView);

  if (!view) return null;
  const { run } = view;
  const on = view.traders.filter((t) => t.on);
  const paused = view.traders.filter((t) => !t.on);
  const span = view.recordSpan ?? "over two years";
  const waited = [...new Set((run?.picks ?? []).filter((p) => p.outcome === "waiting" && NO_FREE_SLOT.test(p.reason ?? "")).map((p) => p.symbol))];
  const all = view.traders.length + (view.breakout ? 1 : 0);
  const trading = on.length + (view.breakout?.on ? 1 : 0);

  return (
    <Card aria-label="Daily coin trades" className="flex flex-col gap-2">
      <div>
        <div className="text-sm font-semibold">Daily coin trades (paper)</div>
        <div className="text-xs tabular-nums text-muted" data-testid="daily-status">
          {run ? `Last check ${when(run.at)} · ${run.coins} coins · next ${when(view.nextAt)}` : `First check ${when(view.nextAt)}`}
        </div>
      </div>

      {view.coinSlots && <CoinSlots used={view.coinSlots.used} max={view.coinSlots.max} waited={waited} />}

      {run && (
        <div className="flex flex-col gap-1" data-testid="daily-picks">
          {run.note && <div className="text-xs text-warn">{run.note}</div>}
          {run.picks.length === 0 ? (
            <div className="text-xs text-muted">No setups that day.</div>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col">
              {run.picks.map((p, k) => (
                <li key={`${p.symbol}-${p.trader}`} className="flex items-start gap-2.5 py-1.5 text-xs nx-row-in" style={{ animationDelay: `${Math.min(k, 8) * 40}ms` }}>
                  <span aria-hidden="true" className={`w-5 h-5 shrink-0 rounded-full bg-inset grid place-items-center font-bold ${OUTCOME[p.outcome].tone}`}>
                    {OUTCOME[p.outcome].icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0">
                        <span className="font-semibold">{coin(p.symbol)}</span> <span className="text-muted">{p.trader}</span>
                      </span>
                      <span className={`shrink-0 font-semibold ${OUTCOME[p.outcome].tone}`}>{OUTCOME[p.outcome].label}</span>
                    </span>
                    {p.reason && <span className="block text-muted">{p.reason}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {run.failed.length > 0 && <div className="text-[11px] text-muted">Couldn't read: {run.failed.map(coin).join(", ")}.</div>}
        </div>
      )}

      {all > 0 && (
        <Fold title={`Which traders trade (${trading} of ${all})`}>
          {view.traders.length > 0 && (
            <div className="p-2.5 rounded-xl bg-inset flex flex-col gap-1.5" data-testid="daily-traders">
              <div className="text-[11px] font-semibold text-muted">Daily record {span} with your trailing stop</div>
              {[...on, ...paused].map((t) => (
                <div key={t.trader} className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums">
                  <span className={t.on ? "" : "text-muted"}>
                    {t.trader}
                    {t.on ? "" : " · paused"}
                  </span>
                  <span className="text-muted ml-auto">
                    {t.trades} setups · <span className={`font-semibold ${pnlTone(t.avgR)}`}>{rSigned(t.avgR)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {view.breakout && (
            <div className="p-2.5 rounded-xl bg-inset flex flex-col gap-1.5" data-testid="daily-breakout">
              <div className="text-[11px] font-semibold text-muted">Breakout record since 2018</div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums">
                <span className={view.breakout.on ? "" : "text-muted"}>
                  {view.breakout.trader}
                  {view.breakout.on ? "" : " · paused"}
                </span>
                <span className="text-muted ml-auto">
                  {view.breakout.trades} trades · <span className={`font-semibold ${pnlTone(view.breakout.avgR)}`}>{rSigned(view.breakout.avgR)}</span>
                </span>
              </div>
            </div>
          )}
        </Fold>
      )}

      <Fold title="How the daily check works">
        <div className="text-xs text-muted leading-relaxed">
          Once a day, just after the daily candle closes (5:30 am), the server checks coins on daily candles and opens paper trades within
          your coin limits. Only traders whose daily record {span} is positive over 10+ setups trade. Trades are held up to 30 days.
          Breakout 55/20 trades alongside them on this year's biggest coins: it buys a close above the 55-day high and sells a close below
          the 20-day low, with no target and no trailing stop.
        </div>
      </Fold>
    </Card>
  );
};
