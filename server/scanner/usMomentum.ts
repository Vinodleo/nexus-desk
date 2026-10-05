import fs from "fs";
import path from "path";
import type { StrategySetup, TradeProposal } from "../../src/types";
import { CLASSIC_STRATEGIES, momentumEntryAt, momentumRise, momentumTop, sma, type ClassicRecords } from "../../src/services/classicStrategies";
import type { CandleSeries } from "../../src/services/historyReplay";
import { isUsSymbol, nyParts, usSymbol, US_SQUARE_OFF } from "../../src/shared/usMarket";
import { fetchUsDailyBars, fetchUsSessions, fetchUsSnapshots, type UsQuote } from "../alpaca";
import { usdInr } from "../fx";
import { closeServerPosition, daemonPositions, type DaemonPosition } from "../guardian";
import { MARKET_FUND, stocksLongClassic } from "../history/stocksLong";
import { getDeskState, scanningDesks, type DeskState } from "./deskState";
import { runServerAutopilot } from "./autopilot";
import { serverDailyPnl } from "./scannerService";
import {
  classicGate,
  dailyPolicy,
  dailyProposal,
  deskNote,
  NO_TARGET,
  PAPER_HOOKS,
  pausedReason,
  slotsInUse,
  type DailyPick,
  type DailyRun,
  type TraderGate,
} from "./dailyCoins";
import { loadUsBreakout, runFundsBreakout, runUsBreakout, usBreakoutBusy, usBreakoutStocks, usCheckDue, US_CHECK_AT, withToday } from "./usBreakout";

// Momentum, top 3, on US stocks (paper, owner's call): the classic strategy
// that was up in 9 of the 11 years since 2016 on them
// (server/history/stocksLong.ts), traded as replayed. On each week's last US
// session (Friday, or the day before a Friday holiday), at 3:45 pm New York,
// just before the close the replay trades at, after US breakout's check:
// - Ranks this year's 20 biggest US stocks (the replay's list) by how much
//   they rose over the last 90 sessions. The top 3 that rose at all are this
//   week's picks, while SPY is above its 200-day average; none when it isn't.
// - Sells a held momentum trade that's no longer a pick, at the bid (even
//   with autopilot off: an open trade keeps its exit). One still a pick is kept.
// - Buys a pick not held, at the ask, with a stop 3 ATR below. No target, no
//   trailing stop, nothing banked early, held overnight for weeks (exitRules'
//   holdingDecision lets momentum trades past the 3:50 close), in fractions
//   of a share. Between checks, only the stop can close it.
// Within your US limits, on momentum's own US slots, through the server
// autopilot, never live. It trades only while its US record since 2016
// averages MIN_EDGE_R+ over MIN_TRADER_TRADES+ trades.

/** Enough completed sessions for the 90-session rise and the 20-day ATR (calendar days). */
const HISTORY_DAYS = 200;
/** Enough of SPY's for its 200-day average (calendar days). */
const FUND_HISTORY_DAYS = 330;
/** Days of SPY's closes its guard averages. */
const GUARD_DAYS = 200;
const PAUSE_MS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60_000;
/** The record US momentum trades are judged on, in words. */
const SPAN = "since 2016";
export const MOMENTUM_NAME = CLASSIC_STRATEGIES.momentum.name;
/** SPY, as the desk names it. */
const FUND = usSymbol(MARKET_FUND.us);

const file = () => path.join(process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data"), "us_momentum.json");

/** One user's weekly check: what it sold, kept and bought, with the week's picks and SPY's guard. */
export interface MomentumRun extends DailyRun {
  /** SPY above its 200-day average at the check (momentum holds stocks only then). */
  marketUp: boolean;
  /** This week's picks: the top 3 by their rise over 90 sessions (0.25 is +25%), best first. */
  top: { symbol: string; rise: number }[];
}

interface Saved {
  /** The New York day of the last check (each weekday's, to see whether it's the week's last session). */
  lastDay: string | null;
  runs: Record<string, MomentumRun | DailyRun>;
}

let state: Saved = { lastDay: null, runs: {} };
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

export interface UsMomentumDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Completed and today's daily candles for a US stock, in dollars, as [openTimeMs, open, high, low, close, volume] rows. */
  daily: (symbol: string, fromMs: number, toMs: number) => Promise<unknown[]>;
  /** Last trade and best bid and ask per stock, in rupees. */
  quotes: (symbols: string[]) => Promise<Record<string, UsQuote>>;
  /** Today's USD/INR rate, or null without one. */
  rate: () => number | null;
  /** The US trading days between two New York days (the market calendar). */
  sessions: (from: string, to: string) => Promise<string[]>;
  /** The stocks' replay's US results (momentum's decides whether it trades), or null before it has run. */
  classic: () => ClassicRecords | null;
  desks: (now: number) => [string, DeskState][];
  dailyPnl: (uid: string, desk: DeskState, now: number) => number;
  open: typeof runServerAutopilot;
  positions: () => DaemonPosition[];
  close: (id: string, price: number) => boolean;
  /** US breakout's check is under way: this one waits for it. */
  busy: () => boolean;
}

const realDeps: UsMomentumDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  daily: fetchUsDailyBars,
  quotes: fetchUsSnapshots,
  rate: usdInr,
  sessions: fetchUsSessions,
  classic: () => stocksLongClassic("us"),
  desks: scanningDesks,
  dailyPnl: serverDailyPnl,
  open: runServerAutopilot,
  positions: () => [...daemonPositions.values()],
  close: (id, price) => closeServerPosition(id, price, "TRAILING_STOP"),
  busy: usBreakoutBusy,
};

const OUTCOME_ORDER: Record<DailyPick["outcome"], number> = { opened: 0, sold: 1, kept: 2, waiting: 3, paused: 4 };

/** Momentum's US record since 2016, as a gate (whether it trades), or undefined before the stocks' replay has run. */
export const momentumGate = (classic: ClassicRecords | null): TraderGate | undefined => classicGate(classic, "momentum");

/** The setup a momentum pick makes at day `i`'s close, in the candles' prices: entry at the close, stop 3 ATR below, no target. */
export function momentumSetup(symbol: string, s: CandleSeries, i: number): StrategySetup | null {
  const e = momentumEntryAt(s, i);
  if (!e) return null;
  return {
    id: `momentum-${symbol}-${s.t[i]}`,
    name: MOMENTUM_NAME,
    family: "trend_following",
    direction: "LONG",
    symbol,
    timeframe: "1d",
    strategy: "momentum",
    entryPrice: e.entry,
    stopLoss: e.entry - e.risk,
    takeProfit: e.entry * NO_TARGET,
    riskRewardRatio: (e.entry * (NO_TARGET - 1)) / e.risk,
    baseProbability: 0.5,
    qualifies: true,
    horizon: "intraday",
    planAtr: e.atr,
    features: { emaAlignment: true, volumeSurgeRatio: 1, vwapDistancePercent: 0, adx: 0, rsi: 50, atr: e.atr },
  };
}

/** Weeks start on Monday: the week a New York day ("2026-10-02") is in. */
const weekOf = (day: string) => Math.floor((Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS) + 3) / 7);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Whether `day` is its week's last US session, as the replay rebalances
 * (stockWeekClose): a trading day with no other one after it that week. A
 * holiday isn't one. Without the calendar, Friday.
 */
export function weekLastSession(day: string, sessions: string[] | null): boolean {
  if (!sessions) return new Date(`${day}T12:00:00Z`).getUTCDay() === 5;
  if (!sessions.includes(day)) return false;
  const next = sessions.filter((d) => d > day).sort()[0];
  return next === undefined || weekOf(next) !== weekOf(day);
}

/** SPY above its 200-day average at its last close (today's price), or null without enough of its candles. */
export function fundUp(s: CandleSeries): boolean | null {
  const last = s.c.length - 1;
  const avg = sma(s.c, GUARD_DAYS)[last];
  return avg === undefined ? null : s.c[last] > avg;
}

/** The week's check, at 3:45 pm New York on the week's last US session. */
export async function runUsMomentum(deps: UsMomentumDeps = realDeps): Promise<void> {
  const now = deps.now();
  const day = nyParts(now).day;
  if (running || deps.busy() || state.lastDay === day || !usCheckDue(now)) return;
  const desks = deps.desks(now);
  const held = deps.positions().filter((p) => p.strategy === "momentum" && isUsSymbol(p.symbol));
  if (desks.length === 0 && held.length === 0) return;
  running = true;
  // Marked first: a restart mid-check doesn't trade the week twice.
  const lastDay = state.lastDay;
  state.lastDay = day;
  save();
  const noteAll = (note: string) => {
    for (const [uid] of desks) state.runs[uid] = { at: now, day, coins: 0, failed: [], picks: [], note };
  };
  try {
    let sessions: string[] | null = null;
    try {
      sessions = await deps.sessions(day, addDays(day, 10));
    } catch (err) {
      console.warn("[UsMomentum] Couldn't read the US market calendar; taking Friday as the week's last session:", err);
    }
    if (!weekLastSession(day, sessions)) return;

    const rate = deps.rate();
    if (!rate) {
      noteAll("No USD/INR rate yet, so US prices couldn't be read.");
      return;
    }
    const list = usBreakoutStocks(Number(day.slice(0, 4)));
    const symbols = [...new Set([...list, ...held.map((p) => p.symbol), FUND])];
    let quotes: Record<string, UsQuote>;
    try {
      quotes = await deps.quotes(symbols);
    } catch (err) {
      // Nothing traded yet: the next minute tries again, until 3:50.
      state.lastDay = lastDay;
      console.warn("[UsMomentum] Couldn't read US prices; trying again:", err);
      return;
    }
    const failed: string[] = [];
    const candles = new Map<string, CandleSeries>();
    for (const symbol of symbols) {
      const quote = quotes[symbol];
      try {
        const rows = await deps.daily(symbol, now - (symbol === FUND ? FUND_HISTORY_DAYS : HISTORY_DAYS) * DAY_MS, now);
        if (!quote) throw new Error("no price now");
        candles.set(symbol, withToday(rows, day, rate, quote.price, now));
      } catch {
        failed.push(symbol);
      }
      await deps.sleep(PAUSE_MS);
    }
    const fund = candles.get(FUND);
    const marketUp = fund ? fundUp(fund) : null;
    if (marketUp === null) {
      // Without SPY's guard nothing is judged: the next minute tries again, until 3:50.
      state.lastDay = lastDay;
      noteAll("Couldn't read SPY's daily candles, so nothing was bought or sold; trying again until 3:50 pm New York.");
      return;
    }

    // This week's picks: the top 3 on this year's list by their rise over 90 sessions, while SPY is above its 200-day.
    const top = marketUp
      ? momentumTop(
          list.flatMap((symbol) => {
            const s = candles.get(symbol);
            const rise = s ? momentumRise(s, s.t.length - 1) : undefined;
            return rise !== undefined ? [{ symbol, rise }] : [];
          })
        )
      : [];
    const picked = new Set(top.map((t) => t.symbol));
    const pct = (rise: number) => `${rise >= 0 ? "+" : "−"}${Math.abs(rise * 100).toFixed(0)}%`;
    const riseOf = (symbol: string) => top.find((t) => t.symbol === symbol)?.rise ?? 0;

    // Held trades no longer picked are sold first, freeing their slots; those still picked are kept.
    const heldFor = new Map<string, DailyPick[]>();
    const kept = new Set<string>();
    for (const p of held) {
      const uid = p.userId ?? "";
      let pick: DailyPick;
      if (picked.has(p.symbol)) {
        kept.add(p.id);
        pick = { symbol: p.symbol, trader: MOMENTUM_NAME, outcome: "kept", reason: `still in the top 3 (${pct(riseOf(p.symbol))} over 90 sessions)` };
      } else if (marketUp && !candles.has(p.symbol)) {
        // Can't tell whether it's still a pick: kept a week more.
        kept.add(p.id);
        pick = { symbol: p.symbol, trader: MOMENTUM_NAME, outcome: "waiting", reason: "couldn't read its candles, so kept until next week; its stop still guards it" };
      } else {
        const why = !marketUp ? "SPY is below its 200-day average" : list.includes(p.symbol) ? "out of the top 3" : "no longer on this year's list";
        const quote = quotes[p.symbol];
        const sold = deps.close(p.id, quote?.bid ?? quote?.price ?? 0);
        if (!sold) kept.add(p.id);
        pick = sold
          ? { symbol: p.symbol, trader: MOMENTUM_NAME, outcome: "sold", reason: why }
          : { symbol: p.symbol, trader: MOMENTUM_NAME, outcome: "waiting", reason: `${why}, but no price to sell at; its stop still guards it` };
      }
      heldFor.set(uid, [...(heldFor.get(uid) ?? []), pick]);
    }

    const gate = momentumGate(deps.classic());
    const runFor = (picks: DailyPick[], note?: string): MomentumRun => ({
      at: now,
      day,
      coins: symbols.length,
      failed,
      picks: picks.sort((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]),
      marketUp,
      top,
      ...(note ? { note } : {}),
    });
    for (const [uid, desk] of desks) {
      const policy = dailyPolicy(desk);
      const note = deskNote(uid, desk, policy, deps, now);
      const picks: DailyPick[] = [...(heldFor.get(uid) ?? [])];
      // One momentum trade per stock: a pick already held is kept, not bought again.
      const holding = new Set(held.filter((p) => (p.userId ?? "") === uid && kept.has(p.id)).map((p) => p.symbol));
      const proposals: TradeProposal[] = [];
      for (const { symbol, rise } of top) {
        if (holding.has(symbol)) continue;
        if (!gate?.on) {
          picks.push({ symbol, trader: MOMENTUM_NAME, outcome: "paused", reason: pausedReason(gate, SPAN).replace("daily record", "record") });
          continue;
        }
        const s = candles.get(symbol)!;
        const setup = momentumSetup(symbol, s, s.t.length - 1);
        if (!setup) {
          picks.push({ symbol, trader: MOMENTUM_NAME, outcome: "waiting", reason: "not enough candles for its stop yet" });
          continue;
        }
        const quote = quotes[symbol];
        const proposal = dailyProposal({ symbol, regime: "trending_bullish", setup }, quote.ask ?? quote.price, gate as TraderGate, policy, day, now, SPAN);
        proposals.push({ ...proposal, supervisorNotes: `Momentum: ${pct(rise)} over 90 sessions, in this week's top 3. Its record ${SPAN} decides.` });
      }
      if (note) {
        for (const p of proposals) picks.push({ symbol: p.symbol, trader: MOMENTUM_NAME, outcome: "waiting", reason: note });
      } else if (proposals.length > 0) {
        const livePrice = (s: string) => quotes[s]?.ask ?? quotes[s]?.price;
        const marked = await deps.open(uid, desk, proposals, policy, { livePrice, barAtr: () => undefined }, now, PAPER_HOOKS);
        for (const p of marked) {
          picks.push(
            p.status === "APPROVED"
              ? { symbol: p.symbol, trader: MOMENTUM_NAME, outcome: "opened" }
              : { symbol: p.symbol, trader: MOMENTUM_NAME, outcome: "waiting", reason: p.deferralReason ?? "not opened" }
          );
        }
      }
      state.runs[uid] = runFor(picks, note ?? undefined);
      console.log(`[UsMomentum] ${day}: SPY ${marketUp ? "up" : "down"}, top ${top.map((t) => t.symbol).join(", ") || "none"}; opened ${picks.filter((p) => p.outcome === "opened").map((p) => p.symbol).join(", ") || "none"} for ${uid}.`);
    }
    // Sales for a desk that isn't scanning (it still holds its momentum trades).
    for (const [uid, picks] of heldFor) {
      if (!desks.some(([d]) => d === uid)) state.runs[uid] = runFor(picks);
    }
  } catch (err) {
    console.error("[UsMomentum] Check failed:", err);
  } finally {
    save();
    running = false;
  }
}

/** The next check's time: 3:45 pm New York on the next Friday whose check hasn't run (the day before, when Friday is a holiday). */
export function nextMomentumCheckAt(now: number, lastDay: string | null): number {
  for (let k = 0; k < 9; k++) {
    const date = new Date(now + k * DAY_MS);
    // 3:45 pm New York is 19:45 UTC in summer time, 20:45 in winter.
    for (const hour of [19, 20]) {
      const at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, 45);
      const p = nyParts(at);
      if (p.minutes === US_CHECK_AT && p.weekday === 5 && p.day !== lastDay && at + (US_SQUARE_OFF - US_CHECK_AT) * 60_000 > now) return at;
    }
  }
  return now;
}

/** What the Lab shows a user: the last weekly check, momentum's US record and whether it trades, its US slots, and the next check. */
export function usMomentumView(uid: string, now: number = Date.now()) {
  const desk = getDeskState(uid);
  return {
    run: state.runs[uid] ?? null,
    gate: momentumGate(realDeps.classic()) ?? null,
    /** US momentum trades open now against momentum's own US slots. */
    slots: desk ? slotsInUse(uid, desk, "us", "momentum") : null,
    nextAt: nextMomentumCheckAt(now, state.lastDay),
  };
}

export function loadUsMomentum(): void {
  try {
    if (!fs.existsSync(file())) return;
    const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (saved && typeof saved === "object") state = { lastDay: typeof saved.lastDay === "string" ? saved.lastDay : null, runs: saved.runs ?? {} };
  } catch (err) {
    console.warn("[UsMomentum] Couldn't read the last check:", err);
  }
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(`${file()}.tmp`, JSON.stringify(state), "utf8");
    fs.renameSync(`${file()}.tmp`, file());
  } catch (err) {
    console.warn("[UsMomentum] Couldn't save the check:", err);
  }
}

/**
 * Checks every minute whether the US checks are due: breakout's, then
 * momentum's, one after the other, so each sees what the other opened (one
 * trade per stock, at most 2 in a sector).
 */
export function startUsChecks(): void {
  loadUsBreakout();
  loadUsMomentum();
  // US stocks' breakout, the funds' breakout, then momentum: each sees the trades the one before opened.
  timer = setInterval(async () => {
    await runUsBreakout();
    await runFundsBreakout();
    await runUsMomentum();
  }, CHECK_EVERY_MS);
}

/** Test hooks. */
export function _resetUsMomentum(): void {
  state = { lastDay: null, runs: {} };
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
}
export function _usMomentumState(): Saved {
  return state;
}
