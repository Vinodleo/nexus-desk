import fs from "fs";
import path from "path";
import { allLivePositions, fetchCoinBalances, hasCoinDcxKeys, type LivePositionRecord } from "./liveExecution";
import { currentPrices } from "./realtime";
import { coinProblemMessage, type CoinDcxCheckReport, type CoinProblem } from "../src/shared/coinDcxCheck";

// The daily check against CoinDCX: the coins held there match the open live
// trades this server knows (liveExecution.ts's records). Hourly while live
// trades are open, daily otherwise (it then just confirms the keys work).
// Mismatches (src/shared/coinDcxCheck.ts):
// - a coin held well under what its open live trades bought ("missing"):
//   sold or moved outside the app, so the server's stop and exit can't sell it;
// - a little under, up to FEE_SHORT ("fee"): most likely CoinDCX took the
//   buying fee in coins, and selling the whole quantity would be refused;
// - a failed exit's coins still there ("unsold").
// Each is told by pop-up once seen on two checks in a row (the second 5
// minutes after the first, so an order filling mid-check doesn't count), and
// at most once a day. Coins held beyond the live trades (the owner's own, or
// left over) are only listed in Settings: they're not the app's to sell.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Daily without live trades (a little under a day, so it doesn't drift later each day). */
export const CHECK_DAILY_MS = DAY_MS - 30 * 60 * 1000;
/** Hourly while live trades are open, a mismatch is shown, or the last try failed. */
export const CHECK_LIVE_MS = 60 * 60 * 1000;
/** A first sighting of a mismatch is checked again this much later before anyone is told. */
export const CONFIRM_MS = 5 * 60 * 1000;
/** A trade opened this recently may still be filling: not compared yet. */
export const SETTLE_MS = 5 * 60 * 1000;
/** Shortfalls under this share of the quantity are rounding. */
export const MATCH_SLACK = 1e-4;
/** Shortfalls up to this share are the size of a fee taken in coins. */
export const FEE_SHORT = 0.01;
/** A failed exit is looked for at CoinDCX this long after its last try. */
export const FAILED_RECENT_MS = 7 * DAY_MS;
/** Coins held beyond the live trades worth less than this (₹) are dust: not listed. */
const DUST_INR = 100;
const CASH = new Set(["INR", "USDT"]);
const TICK_MS = 5 * 60 * 1000;
const FIRST_CHECK_MS = 10 * 60 * 1000;
const STATUS_FILE = "coindcx_check.json";
const ERROR_KEY = "error";

const dataDir = () => process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** "BTCINR" → "BTC". */
export const baseCoin = (market: string) => market.toUpperCase().replace(/(INR|USDT)$/, "");
const problemKey = (p: CoinProblem) => `${p.coin}:${p.kind}`;

interface CheckState extends Omit<CoinDcxCheckReport, "configured" | "liveTrades"> {
  /** Mismatches seen once, checked again CONFIRM_MS later. */
  pending: string[];
  /** What was told by pop-up today, by mismatch (and ERROR_KEY): once a day each. */
  told: Record<string, string>;
}

const blank = (): CheckState => ({
  lastAt: null,
  lastTriedAt: null,
  trades: 0,
  coins: [],
  problems: [],
  extras: [],
  lastError: null,
  lastErrorAt: null,
  pending: [],
  told: {},
});

let state: CheckState = blank();
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export interface CoinDcxCheckDeps {
  now: () => number;
  dir: () => string;
  configured: () => boolean;
  records: () => LivePositionRecord[];
  balances: () => Promise<Record<string, number>>;
  /** A coin's price in rupees, when the server knows it (to leave out dust). */
  priceOf: (coin: string) => number | undefined;
  notify: (title: string, body: string, tag: string) => void;
}

const realDeps: CoinDcxCheckDeps = {
  now: () => Date.now(),
  dir: dataDir,
  configured: hasCoinDcxKeys,
  records: allLivePositions,
  balances: fetchCoinBalances,
  priceOf: (coin) => currentPrices[`${coin}/INR`],
  notify: () => {},
};

/** Live trades open now: the check runs hourly while there are any. */
export const liveOpenCount = (records: LivePositionRecord[]) => records.filter((r) => r.status === "OPEN" || r.status === "EXIT_PENDING").length;

/**
 * Compares what CoinDCX holds (`held`, by currency, open orders' share
 * included) with the live longs: settled open trades should all be there, and
 * a recently failed exit's coins shouldn't. Trades being closed (an exit on
 * its way) aren't compared: their coins may or may not be sold yet.
 */
export function compareHoldings(
  records: LivePositionRecord[],
  held: Record<string, number>,
  now: number,
  priceOf: (coin: string) => number | undefined = () => undefined
): { trades: number; coins: string[]; problems: CoinProblem[]; extras: Array<{ coin: string; held: number }> } {
  const open = new Map<string, { qty: number; ids: string[] }>();
  const failed = new Map<string, { qty: number; ids: string[] }>();
  const add = (into: typeof open, coin: string, r: LivePositionRecord) => {
    const cur = into.get(coin) ?? { qty: 0, ids: [] };
    into.set(coin, { qty: cur.qty + r.quantity, ids: [...cur.ids, r.positionId] });
  };
  let trades = 0;
  for (const r of records) {
    if (r.entrySide !== "buy" || !(r.quantity > 0)) continue;
    const coin = baseCoin(r.market);
    if (r.status === "OPEN" && now - Date.parse(r.openedAt) >= SETTLE_MS) {
      add(open, coin, r);
      trades++;
    } else if (r.status === "EXIT_FAILED" && now - Date.parse(r.exitSentAt ?? r.openedAt) <= FAILED_RECENT_MS) {
      add(failed, coin, r);
    }
  }

  const problems: CoinProblem[] = [];
  for (const [coin, o] of open) {
    const h = held[coin] ?? 0;
    const short = o.qty - h;
    if (short <= o.qty * MATCH_SLACK) continue;
    problems.push({ coin, kind: short <= o.qty * FEE_SHORT ? "fee" : "missing", expected: o.qty, held: h, positions: o.ids });
  }
  const unsold = new Set<string>();
  for (const [coin, f] of failed) {
    const beyond = (held[coin] ?? 0) - (open.get(coin)?.qty ?? 0);
    if (beyond >= f.qty * (1 - FEE_SHORT)) {
      problems.push({ coin, kind: "unsold", expected: f.qty, held: beyond, positions: f.ids });
      unsold.add(coin);
    }
  }

  const extras: Array<{ coin: string; held: number }> = [];
  for (const [coin, h] of Object.entries(held)) {
    if (CASH.has(coin) || unsold.has(coin) || !(h > 0)) continue;
    const beyond = h - (open.get(coin)?.qty ?? 0);
    if (beyond <= h * MATCH_SLACK) continue;
    const price = priceOf(coin);
    if (price !== undefined && beyond * price < DUST_INR) continue;
    extras.push({ coin, held: beyond });
  }
  problems.sort((a, b) => a.coin.localeCompare(b.coin));
  extras.sort((a, b) => a.coin.localeCompare(b.coin));
  return { trades, coins: [...open.keys()].sort(), problems, extras };
}

function loadState(dir: string): void {
  try {
    const file = path.join(dir, STATUS_FILE);
    if (fs.existsSync(file)) state = { ...state, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {}
}

function saveState(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${STATUS_FILE}.tmp`), JSON.stringify(state), "utf8");
    fs.renameSync(path.join(dir, `${STATUS_FILE}.tmp`), path.join(dir, STATUS_FILE));
  } catch {}
}

/** Due: never tried; a first sighting to confirm; hourly while live trades are open, a mismatch shows or it failed; else daily. */
export function checkDue(s: Pick<CheckState, "lastTriedAt" | "pending" | "problems" | "lastError">, now: number, liveOpen: boolean): boolean {
  if (s.lastTriedAt === null) return true;
  const since = now - s.lastTriedAt;
  if (s.pending.length > 0) return since >= CONFIRM_MS;
  return since >= (liveOpen || s.problems.length > 0 || s.lastError ? CHECK_LIVE_MS : CHECK_DAILY_MS);
}

/** Reads CoinDCX's balances and compares them with the live trades. "off" without CoinDCX keys. */
export async function runCoinDcxCheck(deps: CoinDcxCheckDeps = realDeps): Promise<"done" | "off" | "failed"> {
  if (!deps.configured() || running) return "off";
  running = true;
  const now = deps.now();
  const day = isoDay(now);
  // Once-a-day pop-ups: only today's are remembered.
  const told = Object.fromEntries(Object.entries(state.told).filter(([, d]) => d === day));
  state = { ...state, lastTriedAt: now, told };
  try {
    const held = await deps.balances();
    // The trades as they stand once CoinDCX has answered: one closed meanwhile isn't expected there.
    const result = compareHoldings(deps.records(), held, deps.now(), deps.priceOf);
    const seenBefore = new Set([...state.pending, ...state.problems.map(problemKey)]);
    const confirmed = result.problems.filter((p) => seenBefore.has(problemKey(p)));
    const pending = result.problems.filter((p) => !seenBefore.has(problemKey(p))).map(problemKey);
    state = { ...state, lastAt: now, trades: result.trades, coins: result.coins, problems: confirmed, pending, extras: result.extras, lastError: null, lastErrorAt: null };
    for (const p of confirmed) {
      if (state.told[problemKey(p)] === day) continue;
      state.told[problemKey(p)] = day;
      const { title, body } = coinProblemMessage(p);
      console.warn(`[CoinDCX check] ${title}: ${body}`);
      deps.notify(title, body, `coindcx-check-${p.coin}`);
    }
    if (result.problems.length === 0) console.log(`[CoinDCX check] ${result.trades} live trade(s); the coins at CoinDCX match.`);
    return "done";
  } catch (err: any) {
    const why = err?.message || String(err);
    state = { ...state, lastError: why, lastErrorAt: now };
    console.error("[CoinDCX check] Couldn't read CoinDCX's balances:", why);
    // Told only while live trades are open: then they're unchecked.
    if (liveOpenCount(deps.records()) > 0 && state.told[ERROR_KEY] !== day) {
      state.told[ERROR_KEY] = day;
      deps.notify("CoinDCX check failed", `Couldn't read the balances at CoinDCX (${why}), so the live trades there are unchecked. It tries again within the hour.`, "coindcx-check-error");
    }
    return "failed";
  } finally {
    saveState(deps.dir());
    running = false;
  }
}

/** For Settings. */
export function coinDcxCheckStatus(): CoinDcxCheckReport {
  const { pending: _pending, told: _told, ...shown } = state;
  return { configured: hasCoinDcxKeys(), liveTrades: liveOpenCount(allLivePositions()), ...shown };
}

/** Looks every few minutes (first a few minutes after start) whether a check is due. */
export function startCoinDcxCheck(notify: CoinDcxCheckDeps["notify"]): void {
  loadState(dataDir());
  const deps = { ...realDeps, notify };
  const tick = () => {
    timer = setTimeout(tick, TICK_MS);
    if (deps.configured() && checkDue(state, Date.now(), liveOpenCount(deps.records()) > 0)) void runCoinDcxCheck(deps);
  };
  timer = setTimeout(tick, FIRST_CHECK_MS);
}

/** Test hooks. */
export function _resetCoinDcxCheck(): void {
  state = blank();
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
export function _coinDcxCheckState(): CheckState {
  return state;
}
export function _loadCoinDcxCheck(dir: string): void {
  loadState(dir);
}
