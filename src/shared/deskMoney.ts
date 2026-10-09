// The desk's money, worked out from its closed trades (the server's trade
// book, server/tradeBook.ts) instead of a running total on each phone: where
// the money stood at a moment (the anchor, kept on the server so every device
// agrees), plus every trade closed after it. Each trade counts once, however
// many times it arrives, so no close can be credited twice or missed by one
// device and not another.

/** Where the money stood at `at` (ms): set when paper money starts again, and once when a phone first moves to this. */
export interface MoneyAnchor {
  at: number;
  equity: number;
  allTimeRealizedPnl: number;
  /** What the paper balance last started at (Settings → Paper money). */
  start: number;
}

export interface DeskMoney {
  equity: number;
  /** The same as equity: a paper desk never takes cash out when a trade opens (paperCash.ts counts what's tied up). */
  cash: number;
  /** Closes today, India time. */
  dailyRealizedPnl: number;
  allTimeRealizedPnl: number;
}

/** What the money sums need of a closed trade. */
export interface MoneyTrade {
  id: string;
  positionId?: string;
  realizedPnl: number;
  closedAtMs?: number;
}

/** Where the money stood when the app opened, before it has an anchor: closes it didn't hold then count on top. */
export interface MoneyBase {
  equity: number;
  allTimeRealizedPnl: number;
  /** The closes it held then (positionId, or id). */
  known: ReadonlySet<string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** A trade's key: the position it closed (one close each), or its own id. */
export const tradeKey = (t: Pick<MoneyTrade, "positionId" | "id">) => t.positionId || t.id;

/** A moment's day in India (YYYY-MM-DD). India has no summer time. */
export function istDay(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const istDayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS;
const cents = (n: number) => Number(n.toFixed(2));

/** Each trade once, with a close time and a finite result. */
function* counted(trades: readonly MoneyTrade[]): Generator<MoneyTrade & { closedAtMs: number }> {
  const seen = new Set<string>();
  for (const t of trades) {
    const key = tradeKey(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!Number.isFinite(t.closedAtMs) || !Number.isFinite(t.realizedPnl)) continue;
    yield t as MoneyTrade & { closedAtMs: number };
  }
}

function todaysPnl(trades: readonly MoneyTrade[], today: string): number {
  const from = istDayStart(today);
  let sum = 0;
  for (const t of counted(trades)) if (t.closedAtMs >= from && t.closedAtMs < from + DAY_MS) sum += t.realizedPnl;
  return sum;
}

/** The money: the anchor plus every close after it; today's closes for the day's P&L. */
export function deskMoney(anchor: MoneyAnchor, trades: readonly MoneyTrade[], today: string): DeskMoney {
  let since = 0;
  for (const t of counted(trades)) if (t.closedAtMs > anchor.at) since += t.realizedPnl;
  const equity = cents(anchor.equity + since);
  return { equity, cash: equity, dailyRealizedPnl: cents(todaysPnl(trades, today)), allTimeRealizedPnl: cents(anchor.allTimeRealizedPnl + since) };
}

/** The money before there's an anchor: what the phone held when it opened, plus the closes it has taken in since. */
export function moneyFromBase(base: MoneyBase, trades: readonly MoneyTrade[], today: string): DeskMoney {
  let since = 0;
  for (const t of counted(trades)) if (!base.known.has(tradeKey(t))) since += t.realizedPnl;
  const equity = cents(base.equity + since);
  return { equity, cash: equity, dailyRealizedPnl: cents(todaysPnl(trades, today)), allTimeRealizedPnl: cents(base.allTimeRealizedPnl + since) };
}

/**
 * An anchor at `at` that gives the same money now: the closes after `at`
 * taken back out (they count on top of it). A close after `at` that arrives
 * later counts; one before it doesn't, so `at` is set a while back.
 */
export function anchorAt(money: DeskMoney, trades: readonly MoneyTrade[], at: number, start: number): MoneyAnchor {
  let after = 0;
  for (const t of counted(trades)) if (t.closedAtMs > at) after += t.realizedPnl;
  return { at, equity: cents(money.equity - after), allTimeRealizedPnl: cents(money.allTimeRealizedPnl - after), start };
}

/** Paper money started again at `amount`: the all-time P&L from zero (today's still counts toward today's loss limit). */
export function restartAnchor(amount: number, at: number): MoneyAnchor {
  return { at, equity: amount, allTimeRealizedPnl: 0, start: amount };
}

/** An anchor read from the server or storage, if it is one. */
export function cleanAnchor(raw: unknown): MoneyAnchor | null {
  const a = raw as Partial<MoneyAnchor> | null;
  if (!a || typeof a !== "object") return null;
  const { at, equity, allTimeRealizedPnl, start } = a;
  if (![at, equity, allTimeRealizedPnl, start].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if ((at as number) <= 0 || (start as number) <= 0) return null;
  return { at: at as number, equity: equity as number, allTimeRealizedPnl: allTimeRealizedPnl as number, start: start as number };
}

export const sameAnchor = (a: MoneyAnchor | null, b: MoneyAnchor | null) =>
  a === b || (!!a && !!b && a.at === b.at && a.equity === b.equity && a.allTimeRealizedPnl === b.allTimeRealizedPnl && a.start === b.start);
