import fs from "fs";
import path from "path";
import type { TradeProposal } from "../../src/types";
import { appendBars, emptySeries, type CandleSeries } from "../../src/services/historyReplay";
import { breakoutExitAt, type ClassicRecords } from "../../src/services/classicStrategies";
import { cleanMarketLimits } from "../../src/shared/marketLimits";
import { isUsSymbol, nyParts, usSymbol, US_SQUARE_OFF } from "../../src/shared/usMarket";
import { toClosedBars } from "../../src/services/liveMarketStreamService";
import { fetchUsDailyBars, fetchUsSnapshots, type UsQuote } from "../alpaca";
import { usdInr } from "../fx";
import { closeServerPosition, daemonPositions, type DaemonPosition } from "../guardian";
import { stockCohortFor, stocksLongClassic } from "../history/stocksLong";
import { getDeskState, scanningDesks, type DeskState } from "./deskState";
import { runServerAutopilot } from "./autopilot";
import { serverDailyPnl } from "./scannerService";
import {
  BREAKOUT_NAME,
  breakoutGate,
  breakoutSetup,
  dailyPolicy,
  dailyProposal,
  deskNote,
  PAPER_HOOKS,
  pausedReason,
  type DailyPick,
  type DailyRun,
  type TraderGate,
} from "./dailyCoins";

// Breakout 55/20 on US stocks (paper, owner's call): the classic strategy
// that did best on them since 2016 (server/history/stocksLong.ts), traded as
// replayed. Once each US trading day, at 3:45 pm New York, just before the
// close the replay trades at:
// - Sells a held breakout trade whose price is below its last 20 sessions'
//   low, at the bid (even with autopilot off: an open trade keeps its exit).
// - Buys this year's biggest US stocks (the replay's list) whose price is
//   above their last 55 sessions' high, at the ask, the stop 2 ATR below.
//   No target, no trailing stop, nothing banked early, one trade per stock,
//   held overnight for weeks (exitRules' holdingDecision lets breakout trades
//   past the 3:50 close), in fractions of a share.
// Within your US limits, through the server autopilot, never live. It trades
// only while its US record since 2016 averages MIN_EDGE_R+ over
// MIN_TRADER_TRADES+ trades (breakoutGate on the stocks' replay).

/** 3:45 pm New York: the check runs from then until the 3:50 close of intraday trades. */
export const US_CHECK_AT = 15 * 60 + 45;
const CHECK_EVERY_MS = 60_000;
/** Enough completed sessions for the 55-day high and the 20-day ATR. */
const HISTORY_DAYS = 130;
const PAUSE_MS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The record US breakout trades are judged on, in words. */
const SPAN = "since 2016";

const file = () => path.join(process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data"), "us_breakout.json");

interface Saved {
  /** The New York day of the last check. */
  lastDay: string | null;
  runs: Record<string, DailyRun>;
}

let state: Saved = { lastDay: null, runs: {} };
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

export interface UsBreakoutDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Completed and today's daily candles for a US stock, in dollars, as [openTimeMs, open, high, low, close, volume] rows. */
  daily: (symbol: string, fromMs: number, toMs: number) => Promise<unknown[]>;
  /** Last trade and best bid and ask per stock, in rupees. */
  quotes: (symbols: string[]) => Promise<Record<string, UsQuote>>;
  /** Today's USD/INR rate, or null without one. */
  rate: () => number | null;
  /** The stocks' replay's US results (breakout's decides whether it trades), or null before it has run. */
  classic: () => ClassicRecords | null;
  desks: (now: number) => [string, DeskState][];
  dailyPnl: (uid: string, desk: DeskState, now: number) => number;
  open: typeof runServerAutopilot;
  positions: () => DaemonPosition[];
  close: (id: string, price: number) => boolean;
}

const realDeps: UsBreakoutDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  daily: fetchUsDailyBars,
  quotes: fetchUsSnapshots,
  rate: usdInr,
  classic: () => stocksLongClassic("us"),
  desks: scanningDesks,
  dailyPnl: serverDailyPnl,
  open: runServerAutopilot,
  positions: () => [...daemonPositions.values()],
  close: (id, price) => closeServerPosition(id, price, "TRAILING_STOP"),
};

const OUTCOME_ORDER: Record<DailyPick["outcome"], number> = { opened: 0, sold: 1, waiting: 2, paused: 3 };

/** This year's list, as the desk names US stocks ("AAPL.US"). */
export const usBreakoutStocks = (year: number) => stockCohortFor("us", year).map(usSymbol);

/** Whether `now` is in the check's window on a weekday (US holidays have no new candles, so nothing breaks out then). */
export function usCheckDue(now: number): boolean {
  const { weekday, minutes } = nyParts(now);
  return weekday >= 1 && weekday <= 5 && minutes >= US_CHECK_AT && minutes < US_SQUARE_OFF;
}

/**
 * A stock's daily candles in rupees: its completed sessions (today's partial
 * candle left out), then today so far as one candle at the price now.
 */
export function withToday(rows: unknown[], today: string, rate: number, price: number, now: number): CandleSeries {
  const s = emptySeries();
  const done = toClosedBars(rows, 0, Number.MAX_SAFE_INTEGER).filter((b) => nyParts(b.timestampMs as number).day !== today);
  appendBars(
    s,
    done.map((b) => ({ ...b, open: b.open * rate, high: b.high * rate, low: b.low * rate, close: b.close * rate }))
  );
  appendBars(s, [{ time: "", timestampMs: now, open: price, high: price, low: price, close: price, volume: 0 }]);
  return s;
}

/** The day's check, once, at 3:45 pm New York on a weekday. */
export async function runUsBreakout(deps: UsBreakoutDeps = realDeps): Promise<void> {
  const now = deps.now();
  const day = nyParts(now).day;
  if (running || state.lastDay === day || !usCheckDue(now)) return;
  const desks = deps.desks(now);
  const held = deps.positions().filter((p) => p.strategy === "breakout" && isUsSymbol(p.symbol));
  if (desks.length === 0 && held.length === 0) return;
  running = true;
  // Marked first: a restart mid-check doesn't trade the day twice.
  const lastDay = state.lastDay;
  state.lastDay = day;
  save();
  try {
    const rate = deps.rate();
    const list = usBreakoutStocks(Number(day.slice(0, 4)));
    const symbols = [...new Set([...list, ...held.map((p) => p.symbol)])];
    if (!rate) {
      const note = "No USD/INR rate yet, so US prices couldn't be read.";
      for (const [uid] of desks) state.runs[uid] = { at: now, day, coins: 0, failed: [], picks: [], note };
      return;
    }
    let quotes: Record<string, UsQuote>;
    try {
      quotes = await deps.quotes(symbols);
    } catch (err) {
      // Nothing traded yet: the next minute tries again, until 3:50.
      state.lastDay = lastDay;
      console.warn("[UsBreakout] Couldn't read US prices; trying again:", err);
      return;
    }
    const failed: string[] = [];
    const candles = new Map<string, CandleSeries>();
    for (const symbol of symbols) {
      const quote = quotes[symbol];
      try {
        const rows = await deps.daily(symbol, now - HISTORY_DAYS * DAY_MS, now);
        if (!quote) throw new Error("no price now");
        candles.set(symbol, withToday(rows, day, rate, quote.price, now));
      } catch {
        failed.push(symbol);
      }
      await deps.sleep(PAUSE_MS);
    }

    // Held breakout trades priced below their 20-day low are sold first, freeing their slots.
    const soldFor = new Map<string, DailyPick[]>();
    for (const p of held) {
      const s = candles.get(p.symbol);
      if (!s || !breakoutExitAt(s, s.t.length - 1)) continue;
      const quote = quotes[p.symbol];
      const sold = deps.close(p.id, quote?.bid ?? quote?.price ?? 0);
      const pick: DailyPick = sold
        ? { symbol: p.symbol, trader: BREAKOUT_NAME, outcome: "sold", reason: "closed below its 20-day low" }
        : { symbol: p.symbol, trader: BREAKOUT_NAME, outcome: "waiting", reason: "below its 20-day low, but no price to sell at; its stop still guards it" };
      soldFor.set(p.userId ?? "", [...(soldFor.get(p.userId ?? "") ?? []), pick]);
    }

    const gate = breakoutGate(deps.classic());
    const setups = list.flatMap((symbol) => {
      const s = candles.get(symbol);
      const setup = s ? breakoutSetup(symbol, s, s.t.length - 1) : null;
      return setup ? [{ symbol, setup }] : [];
    });
    for (const [uid, desk] of desks) {
      const policy = dailyPolicy(desk);
      const note = deskNote(uid, desk, policy, deps, now);
      const picks: DailyPick[] = [...(soldFor.get(uid) ?? [])];
      // One breakout trade at a time per stock: a new high while holding one isn't another.
      const inBreakout = new Set(held.filter((p) => (p.userId ?? "") === uid).map((p) => p.symbol));
      const proposals: TradeProposal[] = [];
      for (const { symbol, setup } of setups) {
        if (inBreakout.has(symbol)) continue;
        if (!gate?.on) {
          picks.push({ symbol, trader: BREAKOUT_NAME, outcome: "paused", reason: pausedReason(gate, SPAN).replace("daily record", "record") });
          continue;
        }
        const quote = quotes[symbol];
        proposals.push(dailyProposal({ symbol, regime: "trending_bullish", setup }, quote.ask ?? quote.price, gate as TraderGate, policy, day, now, SPAN));
      }
      if (note) {
        for (const p of proposals) picks.push({ symbol: p.symbol, trader: BREAKOUT_NAME, outcome: "waiting", reason: note });
      } else if (proposals.length > 0) {
        const livePrice = (s: string) => quotes[s]?.ask ?? quotes[s]?.price;
        const marked = await deps.open(uid, desk, proposals, policy, { livePrice, barAtr: () => undefined }, now, PAPER_HOOKS);
        for (const p of marked) {
          picks.push(
            p.status === "APPROVED"
              ? { symbol: p.symbol, trader: BREAKOUT_NAME, outcome: "opened" }
              : { symbol: p.symbol, trader: BREAKOUT_NAME, outcome: "waiting", reason: p.deferralReason ?? "not opened" }
          );
        }
      }
      picks.sort((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]);
      state.runs[uid] = { at: now, day, coins: symbols.length, failed, picks, ...(note ? { note } : {}) };
      console.log(`[UsBreakout] ${day}: ${symbols.length} stocks, opened ${picks.filter((p) => p.outcome === "opened").map((p) => p.symbol).join(", ") || "none"} for ${uid}.`);
    }
    // Sales for a desk that isn't scanning (it still holds its breakout trades).
    for (const [uid, sold] of soldFor) {
      if (!desks.some(([d]) => d === uid)) state.runs[uid] = { at: now, day, coins: symbols.length, failed, picks: sold };
    }
  } catch (err) {
    console.error("[UsBreakout] Check failed:", err);
  } finally {
    save();
    running = false;
  }
}

/** The next check's time: 3:45 pm New York on the next weekday whose check hasn't run. */
export function nextUsCheckAt(now: number, lastDay: string | null): number {
  for (let k = 0; k < 8; k++) {
    const date = new Date(now + k * DAY_MS);
    // 3:45 pm New York is 19:45 UTC in summer time, 20:45 in winter.
    for (const hour of [19, 20]) {
      const at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, 45);
      const p = nyParts(at);
      if (p.minutes === US_CHECK_AT && p.weekday >= 1 && p.weekday <= 5 && p.day !== lastDay && at + 5 * 60_000 > now) return at;
    }
  }
  return now;
}

/** What the Lab shows a user: the last check, breakout's US record and whether it trades, the US slots, and the next check. */
export function usBreakoutView(uid: string, now: number = Date.now()) {
  const desk = getDeskState(uid);
  const used = [...daemonPositions.values()].filter((p) => p.userId === uid && isUsSymbol(p.symbol)).length;
  return {
    run: state.runs[uid] ?? null,
    gate: breakoutGate(realDeps.classic()) ?? null,
    slots: desk ? { used, max: cleanMarketLimits(desk.riskLimits.marketLimits).us.maxOpenTrades } : null,
    nextAt: nextUsCheckAt(now, state.lastDay),
  };
}

export function loadUsBreakout(): void {
  try {
    if (!fs.existsSync(file())) return;
    const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (saved && typeof saved === "object") state = { lastDay: typeof saved.lastDay === "string" ? saved.lastDay : null, runs: saved.runs ?? {} };
  } catch (err) {
    console.warn("[UsBreakout] Couldn't read the last check:", err);
  }
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(`${file()}.tmp`, JSON.stringify(state), "utf8");
    fs.renameSync(`${file()}.tmp`, file());
  } catch (err) {
    console.warn("[UsBreakout] Couldn't save the check:", err);
  }
}

/** Checks every minute whether the day's check is due. */
export function startUsBreakout(): void {
  loadUsBreakout();
  timer = setInterval(() => void runUsBreakout(), CHECK_EVERY_MS);
}

/** Test hooks. */
export function _resetUsBreakout(): void {
  state = { lastDay: null, runs: {} };
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
}
export function _usBreakoutState(): Saved {
  return state;
}
