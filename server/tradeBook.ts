import fs from "fs";
import path from "path";
import { Router, type Request, type Response } from "express";
import type { AuthedRequest } from "./auth";
import type { DaemonClosedTrade } from "./guardian";
import { cleanAnchor, type MoneyAnchor } from "../src/shared/deskMoney";
import { validate, bookImportBody, bookQuery, bookAnchorBody } from "./validation";

// The trade book: every closed trade, per user, kept for good (the guardian
// keeps only its last 200 for its own checks). The guardian adds each close
// it records, its own and the app's (/api/daemon/close), and an app uploads
// the closes it holds from before then, and any made while the server
// couldn't be reached (/api/book/import). The app's Book and money read it
// (/api/book): the money is where it stood at a moment (each user's anchor,
// kept here so every device agrees) plus every close after it
// (src/shared/deskMoney.ts). Saved on each change (closes are a few a day),
// in the daily backup.

export const router = Router();

/** At most this many closed trades kept per user (the oldest go first). */
export const BOOK_MAX_TRADES = 50_000;

/** A close in the book, with when the book took it (an app asks for those taken since it last looked). */
export type BookTrade = DaemonClosedTrade & { bookedAtMs?: number };

const book = new Map<string, BookTrade[]>();
const anchors = new Map<string, MoneyAnchor>();

const dataDir = () => process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const file = () => path.join(dataDir(), "trade_book.json");

/** A close's key: the position it closed (one close each), or the record's own id for one without. */
const keyOf = (t: Pick<DaemonClosedTrade, "positionId" | "id">) => t.positionId || t.id;
const closedMs = (t: DaemonClosedTrade) => Date.parse(t.closedAt) || 0;

export function saveTradeBook(): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, trades: Object.fromEntries(book), anchors: Object.fromEntries(anchors) }));
    fs.renameSync(tmp, file());
  } catch (err) {
    console.error("[TradeBook] Couldn't save the trade book:", err);
  }
}

export function loadTradeBook(): void {
  book.clear();
  anchors.clear();
  try {
    if (!fs.existsSync(file())) return;
    const parsed = JSON.parse(fs.readFileSync(file(), "utf8"));
    for (const [uid, trades] of Object.entries(parsed?.trades ?? {})) {
      if (Array.isArray(trades)) book.set(uid, trades.filter((t) => t && typeof t.symbol === "string" && typeof t.closedAt === "string"));
    }
    for (const [uid, raw] of Object.entries(parsed?.anchors ?? {})) {
      const anchor = cleanAnchor(raw);
      if (anchor) anchors.set(uid, anchor);
    }
  } catch (err) {
    console.error("[TradeBook] Couldn't read the trade book:", err);
  }
}

/** Adds closes not in the book yet (by position), newest first; how many were added. */
export function addToBook(uid: string, trades: DaemonClosedTrade[], opts: { save?: boolean } = {}): number {
  const held = book.get(uid) ?? [];
  const seen = new Set(held.map(keyOf));
  const bookedAtMs = Date.now();
  const fresh = trades
    .filter((t) => {
      const key = keyOf(t);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((t): BookTrade => ({ ...t, bookedAtMs }));
  if (fresh.length === 0) return 0;
  const all = [...held, ...fresh].sort((a, b) => closedMs(b) - closedMs(a)).slice(0, BOOK_MAX_TRADES);
  book.set(uid, all);
  if (opts.save !== false) saveTradeBook();
  return fresh.length;
}

/** A close the guardian recorded. */
export function recordInBook(trade: DaemonClosedTrade): void {
  if (trade.userId) addToBook(trade.userId, [trade]);
}

/** This user's closed trades, newest first. */
export function bookFor(uid: string): BookTrade[] {
  return book.get(uid) ?? [];
}

/** Where this user's money stood at a moment, if set. */
export function anchorFor(uid: string): MoneyAnchor | null {
  return anchors.get(uid) ?? null;
}

/** A closed trade as the app keeps it (HistoricalTrade), in the guardian's shape. */
function fromAppTrade(uid: string, t: Record<string, any>): DaemonClosedTrade {
  const closedAtMs = Number(t.closedAtMs);
  const openedAtMs = Number.isFinite(Number(t.openedAtMs)) ? Number(t.openedAtMs) : closedAtMs;
  const optional = <K extends string>(k: K) => (t[k] !== undefined ? { [k]: t[k] } : {});
  return {
    id: t.id,
    positionId: t.positionId || t.id,
    symbol: t.symbol,
    direction: t.direction,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    quantity: t.quantity,
    moneyPlaced: t.moneyPlaced ?? t.entryPrice * t.quantity,
    grossPnl: t.grossPnl ?? t.realizedPnl + (t.feesPaid ?? 0),
    feesPaid: t.feesPaid ?? 0,
    realizedPnl: t.realizedPnl,
    realizedPnlPercent: t.realizedPnlPercent ?? 0,
    isWin: t.isWin ?? t.realizedPnl >= 0,
    exitReason: t.exitReason,
    closedAt: new Date(closedAtMs).toISOString(),
    openedAt: new Date(openedAtMs).toISOString(),
    userId: uid,
    ...optional("setupName"),
    ...optional("holdingDurationMinutes"),
    ...optional("isLiveOrder"),
    ...optional("isSelfApproved"),
    ...optional("openedByServer"),
    ...optional("riskAtOpen"),
    ...optional("stopAtExit"),
    ...optional("fillAtExit"),
    ...optional("highestPrice"),
    ...optional("lowestPrice"),
    ...optional("signalPrice"),
    ...optional("timeframe"),
    ...optional("strategy"),
  } as DaemonClosedTrade;
}

// This user's closed trades (newest first): those closed after `since` (ms)
// and taken in from `bookedSince` (the last answer's bookedUntil) if given;
// and the money's anchor.
router.get("/api/book", validate({ query: bookQuery }), (req: Request, res: Response) => {
  const uid = (req as AuthedRequest).user!.uid;
  const since = Number(req.query.since ?? 0);
  const bookedSince = Number(req.query.bookedSince ?? 0);
  const bookedUntil = Date.now();
  const trades = bookFor(uid).filter(
    (t) => (!(since > 0) || Date.parse(t.closedAt) > since) && (!(bookedSince > 0) || (t.bookedAtMs ?? 0) >= bookedSince)
  );
  res.json({ success: true, trades, bookedUntil, anchor: anchorFor(uid) });
});

// Sets where the money stood: paper money started again (replaces it), or a
// phone's first (`keep`: one already set stays, so the first device's holds).
// Answers with the anchor in force.
router.post("/api/book/anchor", validate({ body: bookAnchorBody }), (req: Request, res: Response) => {
  const uid = (req as AuthedRequest).user!.uid;
  const held = anchorFor(uid);
  if (!(req.body.keep && held)) {
    const { at, equity, allTimeRealizedPnl, start } = req.body.anchor as MoneyAnchor;
    anchors.set(uid, { at, equity, allTimeRealizedPnl, start });
    saveTradeBook();
  }
  res.json({ success: true, anchor: anchorFor(uid) });
});

// The app's closes the book doesn't hold yet: from before it was kept, or
// made while the server couldn't be reached. Ones it holds are left as they are.
router.post("/api/book/import", validate({ body: bookImportBody }), (req: Request, res: Response) => {
  const uid = (req as AuthedRequest).user!.uid;
  const trades = (req.body.trades as Record<string, any>[]).map((t) => fromAppTrade(uid, t));
  const added = addToBook(uid, trades);
  res.json({ success: true, added, held: bookFor(uid).length });
});

/** Test hook. */
export function _resetTradeBook(): void {
  book.clear();
  anchors.clear();
}
