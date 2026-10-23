import React, { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Card } from "./ui";
import { untilText } from "./FloorDesk";
import { pnlTone } from "./format";
import { rSigned } from "./LedgerBreakdown";
import { useLabFeed } from "./labFeed";
import { Fold, LabChip } from "./labUi";

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
    picks: { symbol: string; trader: string; outcome: "opened" | "sold" | "kept" | "waiting" | "paused"; reason?: string }[];
    note?: string;
  } | null;
  /** Each trader's record and whether it trades; with its wins and the R won and lost from servers since the scorecard. */
  traders: { trader: string; trades: number; avgR: number; on: boolean; wins?: number; winR?: number; lossR?: number }[];
  /** The years the traders' records cover, in words ("since 2017"); absent from older servers (two years). */
  recordSpan?: string | null;
  /** The daily traders are switched off (owner's call, 5 Oct 2026): none trades, whatever its record. Absent from older servers. */
  dailyTradersOff?: boolean;
  /** Breakout 55/20's record since 2018 and whether it trades; null before it has run, absent from older servers. */
  breakout?: { trader: string; trades: number; avgR: number; on: boolean; wins?: number; winR?: number; lossR?: number } | null;
  /**
   * Coin trades open now against the coin limit, and breakout's against its
   * own slots (absent from servers before them); null before the app has
   * sent its settings, absent from older servers.
   */
  coinSlots?: { used: number; max: number; breakout?: { used: number; max: number } } | null;
  nextAt: number;
}

/** A reply this card can show (an older server has no such route). */
export const isDailyCoinsView = (body: any): body is DailyCoinsView => !!body && Array.isArray(body.traders) && typeof body.nextAt === "number";

export const when = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** Each outcome's word, sign and colour: the sign says it as well as the colour. */
const OUTCOME = {
  opened: { label: "opened", icon: "↑", tone: "text-gain" },
  sold: { label: "sold", icon: "↓", tone: "text-accent" },
  kept: { label: "kept", icon: "=", tone: "text-ink" },
  waiting: { label: "not opened", icon: "○", tone: "text-warn" },
  paused: { label: "paused", icon: "‖", tone: "text-muted" },
} as const;

/** The autopilot's reason when a market's slots were full ("would exceed 2 open coin trades at once"), or breakout's, momentum's or the funds' own. */
const noFreeSlot = (kind: "breakout" | "momentum" | "funds" | null) =>
  kind === "funds" ? /open funds breakout trades? at once/ : new RegExp(`open (coin|US stock)${kind ? ` ${kind}` : ""} trades? at once`);
/** A coin or US stock without its suffix ("SOL", "AAPL"). */
export const shortName = (symbol: string) => symbol.replace(/\/INR$|\.US$/, "");

type Pick = NonNullable<DailyCoinsView["run"]>["picks"][number];

/** The check's picks that waited for a free slot: breakout's or momentum's own, or the rest's. */
export const waitedForSlot = (picks: Pick[], kind: "breakout" | "momentum" | "funds" | null = null): string[] =>
  [...new Set(picks.filter((p) => p.outcome === "waiting" && noFreeSlot(kind).test(p.reason ?? "")).map((p) => p.symbol))];

/** A market's trades open now against its limit, and which of the day's setups waited for a slot. */
export const SlotsMeter: React.FC<{ used: number; max: number; waited: string[]; label: string; setting: string; testId: string; row?: string }> = ({
  used,
  max,
  waited,
  label,
  setting,
  testId,
  row = "trades at once",
}) => {
  if (max === 0)
    return (
      <div className="p-2.5 rounded-xl bg-inset text-xs text-muted" data-testid={testId}>
        {label} slots: off. Settings → {setting}: {row} turns them on.
      </div>
    );
  // A square a slot: filled while in use, dashed while free (as Settings → Your limits shows them).
  const segments = Math.min(max, 12);
  const size = segments <= 6 ? "w-7 h-7 rounded-lg" : "w-4 h-4 rounded-md";
  return (
    <div className="p-2.5 rounded-xl bg-inset flex items-center gap-3" data-testid={testId}>
      <div className="flex flex-wrap gap-1.5 shrink-0 max-w-[50%]" aria-hidden="true">
        {Array.from({ length: segments }, (_, k) => (
          <span key={k} className={`${size} ${k < used ? "bg-accent" : "border-[1.5px] border-dashed border-line"}`} />
        ))}
      </div>
      <div className="text-xs leading-snug min-w-0">
        <span className="font-semibold tabular-nums">
          {label} slots: {Math.min(used, max)} of {max} in use
        </span>
        {waited.length > 0 && (
          <span className="block text-muted">
            {waited.map(shortName).join(", ")} waited for a free slot. To take more, raise Settings → {setting}: {row}.
          </span>
        )}
      </div>
    </div>
  );
};

/** How long until a check, in days and hours once it's a day or more away (momentum's is weekly). */
export function checkCountdown(at: number, now: number): string {
  const h = Math.floor((at - now) / 3_600_000);
  return h >= 24 ? `in ${Math.floor(h / 24)} d ${h % 24} h` : untilText(at, now);
}

/** The check's next run counted down (each half minute), with what it last did under it. */
export const NextCheck: React.FC<{ nextAt: number; testId: string; children?: React.ReactNode; now?: number }> = ({ nextAt, testId, children, now }) => {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const id = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [now]);
  const at = now ?? tick;
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-inset p-3">
      <Clock className="w-5 h-5 shrink-0 text-accent" strokeWidth={1.8} aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-sm font-semibold tabular-nums" data-testid={`${testId}-next`}>
          {nextAt > at ? `Next check ${checkCountdown(nextAt, at)}` : "Checking about now"}
        </div>
        <div className="text-xs text-muted tabular-nums" data-testid={testId}>
          {children}
        </div>
      </div>
    </div>
  );
};

const CHIP: Record<Pick["outcome"], { word: string; cls: string }> = {
  opened: { word: "Bought", cls: "bg-gain/15 text-gain" },
  kept: { word: "Kept", cls: "bg-accent-soft text-accent" },
  sold: { word: "Sold", cls: "bg-loss/15 text-loss" },
  waiting: { word: "Waited", cls: "bg-warn-soft text-warn-ink" },
  paused: { word: "Paused", cls: "bg-inset text-muted" },
};

/** A strategy's replayed record, the bar it must clear to trade: its average a trade and how many trades. */
export const RecordLine: React.FC<{ since: string; gate: { trades: number; avgR: number } | null | undefined; testId: string }> = ({ since, gate, testId }) => (
  <div className="flex flex-wrap items-baseline justify-between gap-x-2 tabular-nums" data-testid={testId}>
    {gate ? (
      <>
        <span className="text-xs font-bold text-muted uppercase tracking-[0.08em]">Record since {since}</span>
        <span className="text-sm font-semibold">
          <span className={pnlTone(gate.avgR)}>{rSigned(gate.avgR)}</span> · {gate.trades} trades
        </span>
      </>
    ) : (
      <span className="text-xs text-muted">Waits for the stocks' replay since {since} to finish.</span>
    )}
  </div>
);

/** What a check did, at a glance: a chip an outcome naming what it did that to (the first three, then how many more). */
export function pickChips(picks: Pick[]): { outcome: Pick["outcome"]; text: string }[] {
  const order: Pick["outcome"][] = ["opened", "sold", "kept", "waiting", "paused"];
  return order.flatMap((outcome) => {
    const names = [...new Set(picks.filter((p) => p.outcome === outcome).map((p) => shortName(p.symbol)))];
    if (names.length === 0) return [];
    const shown = names.slice(0, 3).join(", ");
    return [{ outcome, text: `${CHIP[outcome].word} ${shown}${names.length > 3 ? ` +${names.length - 3}` : ""}` }];
  });
}

/** What a check found and did: chips at a glance, then each pick with its sign and why, then what couldn't be read. */
export const CheckPicks: React.FC<{ run: NonNullable<DailyCoinsView["run"]>; testId: string; empty: string }> = ({ run, testId, empty }) => (
  <div className="flex flex-col gap-2">
    {run.picks.length > 0 && (
      <div className="flex flex-wrap gap-1.5" data-testid={`${testId}-chips`}>
        {pickChips(run.picks).map((c) => (
          <span key={c.outcome} className={`text-xs font-semibold rounded-full px-2.5 py-1 ${CHIP[c.outcome].cls}`}>
            {c.text}
          </span>
        ))}
      </div>
    )}
  <div className="flex flex-col gap-1" data-testid={testId}>
    {run.note && <div className="text-xs text-warn">{run.note}</div>}
    {run.picks.length === 0 ? (
      <div className="text-xs text-muted">{empty}</div>
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
                  <span className="font-semibold">{shortName(p.symbol)}</span> <span className="text-muted">{p.trader}</span>
                </span>
                <span className={`shrink-0 font-semibold ${OUTCOME[p.outcome].tone}`}>{OUTCOME[p.outcome].label}</span>
              </span>
              {p.reason && <span className="block text-muted">{p.reason}</span>}
            </span>
          </li>
        ))}
      </ul>
    )}
    {run.failed.length > 0 && <div className="text-[11px] text-muted">Couldn't read: {run.failed.map(shortName).join(", ")}.</div>}
  </div>
  </div>
);

export const DailyCoinsCard: React.FC = () => {
  const view = useLabFeed("/api/daily-coins", isDailyCoinsView);

  if (!view) return null;
  const { run } = view;
  const on = view.traders.filter((t) => t.on);
  const paused = view.traders.filter((t) => !t.on);
  const span = view.recordSpan ?? "over two years";
  const waited = waitedForSlot(run?.picks ?? []);
  const all = view.traders.length + (view.breakout ? 1 : 0);
  const trading = on.length + (view.breakout?.on ? 1 : 0);

  return (
    <Card aria-label="Daily coin trades" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-base font-bold">Coin breakout 55/20</div>
          <div className="text-xs text-muted">Each day just after 5:30 am, paper or live</div>
        </div>
        {view.breakout && <LabChip status={view.breakout.on ? "trading" : "paused"}>{view.breakout.on ? "Trading" : "Paused"}</LabChip>}
      </div>
      <NextCheck nextAt={view.nextAt} testId="daily-status">
        {run ? `Last check ${when(run.at)} · ${run.coins} coins · next ${when(view.nextAt)}` : `First check ${when(view.nextAt)}`}
      </NextCheck>

      {view.coinSlots && <SlotsMeter used={view.coinSlots.used} max={view.coinSlots.max} waited={waited} label="Coin" setting="Coins" testId="daily-slots" />}
      {view.coinSlots?.breakout && (
        <SlotsMeter
          used={view.coinSlots.breakout.used}
          max={view.coinSlots.breakout.max}
          waited={waitedForSlot(run?.picks ?? [], "breakout")}
          label="Breakout"
          setting="Coins"
          row="breakout trades at once"
          testId="daily-breakout-slots"
        />
      )}

      {run && <CheckPicks run={run} testId="daily-picks" empty="No setups that day." />}

      {view.breakout && <RecordLine since="2018" gate={view.breakout} testId="daily-record" />}

      {all > 0 && (
        <Fold title={`Which traders trade (${trading} of ${all})`}>
          {view.traders.length > 0 && (
            <div className="p-2.5 rounded-xl bg-inset flex flex-col gap-1.5" data-testid="daily-traders">
              <div className="text-[11px] font-semibold text-muted">Daily record {span} with your trailing stop</div>
              {view.dailyTradersOff && (
                <div className="text-xs text-muted leading-snug" data-testid="daily-traders-off">
                  Switched off (your call, 5 Oct): after CoinDCX's real fee they lose together, and one clearing the bar alone is
                  likely luck. Their records stay here to watch.
                </div>
              )}
              {[...on, ...paused].map((t) => (
                <div key={t.trader} className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums">
                  <span className={t.on ? "" : "text-muted"}>
                    {t.trader}
                    {t.on ? "" : view.dailyTradersOff ? " · off" : " · paused"}
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
          Once a day, just after the daily candle closes (5:30 am), the server checks coins on daily candles. Breakout 55/20 trades on
          this year's biggest coins: it buys a close above the 55-day high and sells a close below the 20-day low, with no target and no
          trailing stop, within your coin limits.{" "}
          {view.dailyTradersOff
            ? "The daily traders are switched off: their setups are shown but open nothing."
            : `The daily traders trade alongside it when their daily record ${span} is positive over 10+ setups, held up to 30 days.`}{" "}
          If you switch your desk to live, breakout trades with real money (once the server allows live orders); the daily traders stay
          paper only.
        </div>
      </Fold>
    </Card>
  );
};
