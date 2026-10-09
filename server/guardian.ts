import fs from "fs";
import path from "path";
import { Router, type Request, type Response } from "express";
import type { AuthedRequest } from "./auth";
import { applyGuardianTick, isPastHoldingTime } from "./guardianLogic";
import { getLivePosition, isOpenLivePosition, requestLiveExit, setExchangeStopListener, setStopSource } from "./liveExecution";
import { broadcastToUser } from "./realtime";
import { computeClosedTradePnl } from "../src/shared/tradeMath";
import { blendedExitPrice, riskAtOpen } from "../src/shared/exitRules";
import { closeoutPrice, type Quote } from "../src/shared/quotes";
import { notifyUser, tradeClosedMessage, tradeOpenedMessage } from "./push";

import { validate, closedEventsQuery, daemonCloseBody } from "./validation";
import { slowStrategyOf } from "../src/shared/marketLimits";
import { addToBook, recordInBook } from "./tradeBook";
import type { SlowStrategy } from "../src/types";

export const router = Router();

// ==========================================
// SERVER-SIDE 24/7 POSITION GUARDIAN DAEMON
// ==========================================
// Keeps monitoring trailing stops, take-profit, stop-loss, and max holding time
// even when the browser is asleep, minimized, or closed.

export interface DaemonPosition {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  highestPrice?: number;
  lowestPrice?: number;
  trailActive?: boolean;
  atrAtEntry?: number;
  trailMode?: "SCALP_TIGHT" | "TREND_RUNNER";
  openTime: string;
  expectedHoldingTimeMinutes?: number;
  initialTakeProfit?: number;
  family?: string;
  trailProfile?: string;
  initialStopLoss?: number;
  partialQuantity?: number;
  bankedQuantity?: number;
  bankedPrice?: number;
  isSelfApproved?: boolean;
  setupName?: string;
  userId?: string;
  isLiveOrder?: boolean; // set by the server from its live registry, never trusted from the client
  /** Opened by the server's autopilot (set by the server, never trusted from the client). */
  openedByServer?: boolean;
  /** The price the signal came from, for the entry slippage. */
  signalPrice?: number;
  /** "1d": a coin trade on daily candles, held up to 30 days (scanner/dailyCoins.ts). */
  timeframe?: "1d";
  /** A slower classic strategy's: breakout 55/20's (scanner/dailyCoins.ts, usBreakout.ts sell it on a close below the 20-day low) or US momentum's (scanner/usMomentum.ts sells it once it leaves the top 3). */
  strategy?: SlowStrategy;
}

export interface DaemonClosedTrade {
  id: string;
  positionId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  moneyPlaced: number;
  grossPnl: number;
  feesPaid: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  isWin: boolean;
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "EXPIRY_TIME" | "MANUAL";
  closedAt: string;
  openedAt: string;
  holdingDurationMinutes?: number;
  setupName?: string;
  userId?: string;
  isLiveOrder?: boolean;
  isSelfApproved?: boolean;
  openedByServer?: boolean;
  riskAtOpen?: number;
  stopAtExit?: number;
  fillAtExit?: number;
  /** The best and worst prices seen while it was open (what it could have sold at), for how far it went each way. */
  highestPrice?: number;
  lowestPrice?: number;
  signalPrice?: number;
  timeframe?: "1d";
  strategy?: SlowStrategy;
  /** Closed in the app, which counted it itself (in its daily P&L and losing streak). */
  reportedByApp?: boolean;
}

interface DaemonPersistedState {
  version: number;
  lastUpdated: string;
  positions: DaemonPosition[];
  closedTrades: DaemonClosedTrade[];
}

// Persistent daemon state configuration on disk
const DAEMON_STORAGE_DIR = process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const DAEMON_STORAGE_FILE = path.join(DAEMON_STORAGE_DIR, "daemon_positions_state.json");
const DAEMON_STORAGE_TMP = path.join(DAEMON_STORAGE_DIR, "daemon_positions_state.json.tmp");

// The open positions: the only copy (the app shows them, opens one with its
// order and asks for a close by hand).
export const daemonPositions: Map<string, DaemonPosition> = new Map();
const daemonClosedTrades: DaemonClosedTrade[] = [];
let daemonLastSavedAt: string = new Date().toISOString();

let daemonSaveTimer: NodeJS.Timeout | null = null;

// Synchronous disk save with atomic write (.tmp -> rename)
export function saveDaemonStateToDisk(): void {
  try {
    if (!fs.existsSync(DAEMON_STORAGE_DIR)) {
      fs.mkdirSync(DAEMON_STORAGE_DIR, { recursive: true });
    }
    const state: DaemonPersistedState = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      positions: Array.from(daemonPositions.values()),
      closedTrades: daemonClosedTrades.slice(0, 200),
    };
    daemonLastSavedAt = state.lastUpdated;
    fs.writeFileSync(DAEMON_STORAGE_TMP, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(DAEMON_STORAGE_TMP, DAEMON_STORAGE_FILE);
  } catch (err) {
    console.error("[Daemon Persistence] Error saving daemon state to disk:", err);
  }
}

// Debounced disk save for frequent price updates
export function scheduleDaemonDiskSave(delayMs: number = 3000): void {
  if (daemonSaveTimer) return;
  daemonSaveTimer = setTimeout(() => {
    daemonSaveTimer = null;
    saveDaemonStateToDisk();
  }, delayMs);
}

// Hydrate state from disk on boot to achieve crash recovery
export function loadDaemonStateFromDisk(): void {
  try {
    if (fs.existsSync(DAEMON_STORAGE_FILE)) {
      const raw = fs.readFileSync(DAEMON_STORAGE_FILE, "utf8");
      if (raw && raw.trim().length > 0) {
        const state: DaemonPersistedState = JSON.parse(raw);
        if (Array.isArray(state.positions)) {
          const now = Date.now();
          for (const pos of state.positions) {
            if (pos && pos.id && pos.symbol && pos.entryPrice) {
              // Sanity check: Check if position holding time expired during downtime
              if (isPastHoldingTime(pos, now)) {
                console.log(`[Daemon Crash Recovery] Restored position ${pos.id} (${pos.symbol}) expired during downtime. Auto-closing on recovery.`);
                daemonPositions.set(pos.id, pos);
                executeDaemonExit(pos, pos.currentPrice || pos.entryPrice, "EXPIRY_TIME");
              } else {
                daemonPositions.set(pos.id, pos);
              }
            }
          }
        }
        if (Array.isArray(state.closedTrades)) {
          for (const trade of state.closedTrades) {
            if (trade && trade.id) {
              daemonClosedTrades.push(trade);
            }
          }
          // The trade book holds every close; ones from before it was kept go in (load it first).
          const byUser = new Map<string, DaemonClosedTrade[]>();
          for (const t of daemonClosedTrades) if (t.userId) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t]);
          for (const [uid, trades] of byUser) addToBook(uid, trades);
        }
        console.log(
          `[Daemon Crash Recovery] ⚡ Restored ${daemonPositions.size} open position(s) and ${daemonClosedTrades.length} closed trade event(s) from persistent disk storage! Guardian active immediately upon boot.`
        );
      }
    } else {
      console.log("[Daemon Crash Recovery] No previous state file found on disk. Initializing fresh guardian state.");
    }
  } catch (err) {
    console.error("[Daemon Crash Recovery] Failed to restore daemon state from disk:", err);
  }
}


// Comprehensive daemon state inspector & recovery diagnostics
function ownedBy(uid: string) {
  return (p: { userId?: string }) => p.userId === uid;
}

router.get("/api/daemon/state", (req: Request, res: Response) => {
  const uid = (req as AuthedRequest).user!.uid;
  const mine = Array.from(daemonPositions.values()).filter(ownedBy(uid));
  const myClosed = daemonClosedTrades.filter(ownedBy(uid));
  res.json({
    success: true,
    status: "ACTIVE",
    trackedCount: mine.length,
    activePositions: mine,
    closedEventsCount: myClosed.length,
    recentClosedTrades: myClosed.slice(0, 50),
    persistedStorage: "READY",
    storageFilePath: DAEMON_STORAGE_FILE,
    lastSavedAt: daemonLastSavedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/** A position the app opened within this long is announced as a new trade. */
const NEW_POSITION_NOTIFY_MS = 5 * 60 * 1000;

export type AppPositionOutcome = "taken" | "refused" | "skipped" | "held";

/**
 * A position the app just opened (with its order, /api/execute-trade): the
 * guardian holds it from now on. Refused if the guardian already closed it;
 * skipped if the id is someone else's; one it holds stays as it is; "held"
 * for a new paper trade in a symbol this user already holds (one trade per
 * symbol, as the app's risk check has it: the server's autopilot took it
 * before the app saw it). A live one is taken all the same: its coins are
 * bought, guarded on the server's own quantity, never the app's claim.
 */
export function openAppPosition(uid: string, p: DaemonPosition): AppPositionOutcome {
  if (daemonClosedTrades.some((t) => t.positionId === p.id)) return "refused";
  const existing = daemonPositions.get(p.id);
  if (existing) return existing.userId && existing.userId !== uid ? "skipped" : "taken";

  const live = getLivePosition(p.id);
  const isLive = !!live && live.status === "OPEN" && live.userId === uid;
  if (!isLive) {
    for (const held of daemonPositions.values()) if (held.userId === uid && held.symbol === p.symbol) return "held";
  }
  // Tell the user's devices. (Only a fresh one: an old position re-sent isn't news.)
  if (Date.now() - Date.parse(p.openTime) < NEW_POSITION_NOTIFY_MS) void notifyUser(uid, tradeOpenedMessage(p, "app"));
  // Opened by the server is the server's mark, never the app's claim.
  const { openedByServer: _claimed, ...fromApp } = p;
  daemonPositions.set(p.id, { ...fromApp, userId: uid, isLiveOrder: isLive, ...(isLive ? { quantity: live!.quantity } : {}) });
  saveDaemonStateToDisk();
  return "taken";
}

// Client pulls closed events that occurred server-side while client was asleep
router.get("/api/daemon/closed-events", validate({ query: closedEventsQuery }), (req: Request, res: Response) => {
  const since = Number(req.query.since ?? 0);
  // If since is 0 or negative, return recent events up to 50
  const uid = (req as AuthedRequest).user!.uid;
  const myClosed = daemonClosedTrades.filter(ownedBy(uid));
  const events = since > 0
    ? myClosed.filter(t => new Date(t.closedAt).getTime() > since)
    : myClosed.slice(0, 50);
  res.json({
    success: true,
    events,
    activePositions: Array.from(daemonPositions.values()).filter(ownedBy(uid)),
    lastSavedAt: daemonLastSavedAt
  });
});

type ExitReason = DaemonClosedTrade["exitReason"];

// A close the app asks for (by hand): the guardian closes the position and
// records it, so its closed trades hold every trade (and a live trade's
// exchange exit goes out from here). One already closed answers with its
// record; one the guardian never held, 404.
router.post("/api/daemon/close", validate({ body: daemonCloseBody }), (req: Request, res: Response) => {
  const uid = (req as AuthedRequest).user!.uid;
  const { positionId, price, reason } = req.body as { positionId: string; price: number; reason: ExitReason };
  const pos = daemonPositions.get(positionId);
  if (pos && pos.userId === uid) {
    pos.currentPrice = price;
    const closed = executeDaemonExit(pos, price, reason, { byApp: true });
    return res.json({ success: true, event: closed });
  }
  const earlier = daemonClosedTrades.find((t) => t.positionId === positionId && t.userId === uid);
  if (earlier) return res.json({ success: true, already: true, event: earlier });
  return res.status(404).json({ success: false, error: "The guardian isn't holding that position", code: "NOT_FOUND" });
});

// Process a server-side position exit
function executeDaemonExit(pos: DaemonPosition, exitPrice: number, reason: ExitReason, opts: { byApp?: boolean } = {}): DaemonClosedTrade | undefined {
  if (!daemonPositions.has(pos.id)) return;
  daemonPositions.delete(pos.id);

  const {
    grossPnl: rawGrossPnl,
    feesPaid: totalFeesPaid,
    realizedPnl: finalPnl,
    realizedPnlPercent: pnlPercent,
    entryNotional,
    isWin,
  } = computeClosedTradePnl(
    pos.direction,
    pos.entryPrice,
    exitPrice,
    pos.quantity,
    reason,
    pos.bankedQuantity && pos.bankedPrice !== undefined ? { quantity: pos.bankedQuantity, price: pos.bankedPrice } : undefined,
    pos.symbol
  );

  const exitTimeMs = Date.now();
  const openTimeMs = pos.openTime ? new Date(pos.openTime).getTime() : exitTimeMs;
  const holdingDurationMinutes = Math.max(1, Math.round((exitTimeMs - openTimeMs) / 60000));

  const closedRecord: DaemonClosedTrade = {
    id: `daemon-closed-${exitTimeMs}-${pos.id}`,
    positionId: pos.id,
    symbol: pos.symbol,
    direction: pos.direction,
    entryPrice: pos.entryPrice,
    // Averaged over the half banked at +1R, if any.
    exitPrice: Number(blendedExitPrice(pos, exitPrice).toFixed(8)),
    quantity: pos.quantity,
    moneyPlaced: entryNotional,
    grossPnl: rawGrossPnl,
    feesPaid: totalFeesPaid,
    realizedPnl: finalPnl,
    realizedPnlPercent: pnlPercent,
    isWin,
    exitReason: reason,
    closedAt: new Date(exitTimeMs).toISOString(),
    openedAt: pos.openTime,
    holdingDurationMinutes,
    setupName: pos.setupName || "Statistical Trailing System",
    userId: pos.userId,
    isLiveOrder: !!pos.isLiveOrder,
    isSelfApproved: pos.isSelfApproved,
    riskAtOpen: riskAtOpen(pos),
    ...(pos.openedByServer ? { openedByServer: true } : {}),
    stopAtExit: pos.stopLoss,
    fillAtExit: exitPrice,
    highestPrice: Math.max(pos.highestPrice ?? pos.entryPrice, pos.entryPrice, exitPrice),
    lowestPrice: Math.min(pos.lowestPrice ?? pos.entryPrice, pos.entryPrice, exitPrice),
    ...(pos.signalPrice !== undefined ? { signalPrice: pos.signalPrice } : {}),
    ...(pos.timeframe === "1d" ? { timeframe: "1d" as const } : {}),
    ...(slowStrategyOf(pos.strategy) ? { strategy: slowStrategyOf(pos.strategy) } : {}),
    ...(opts.byApp ? { reportedByApp: true } : {}),
  };

  daemonClosedTrades.unshift(closedRecord);
  if (daemonClosedTrades.length > 200) daemonClosedTrades.pop();
  recordInBook(closedRecord);

  // Save to disk immediately upon any trade exit
  saveDaemonStateToDisk();

  console.log(`[Daemon Position Guardian] Auto-closed ${pos.symbol} (${pos.direction}) @ ${exitPrice} | Reason: ${reason} | PnL: ₹${finalPnl}`);

  // A live position also needs a real exit on the exchange. The server sends
  // it itself (idempotent, retried) so a closed browser can't leave it open.
  // For a live position the P&L above is an estimate at the trigger price;
  // the market exit fills wherever the book is.
  if (pos.isLiveOrder && isOpenLivePosition(pos.id)) {
    requestLiveExit(pos.id, reason).catch((err) =>
      console.error(`[Daemon Position Guardian] Live exit for ${pos.id} errored:`, err)
    );
  }

  // Tell the owner's connected clients immediately, and pop up on their phones.
  broadcastToUser(pos.userId, { type: "DAEMON_POSITION_CLOSED", data: closedRecord });
  void notifyUser(pos.userId, tradeClosedMessage(closedRecord));
  return closedRecord;
}

// The backup stops at CoinDCX (liveExecution.ts) follow this guardian's stop
// for each live long; when one sells the position (the server missed the
// stop, or was down), the guardian closes it at the price CoinDCX got.
setStopSource((id) => {
  const pos = daemonPositions.get(id);
  return pos && pos.isLiveOrder && pos.direction === "LONG" ? pos.stopLoss : undefined;
});
setExchangeStopListener({
  closed: (rec, price) => {
    const pos = daemonPositions.get(rec.positionId);
    if (!pos) return;
    pos.currentPrice = price;
    executeDaemonExit(pos, price, "STOP_LOSS");
  },
  refused: (rec) =>
    void notifyUser(rec.userId, {
      title: `Backup stop refused: ${rec.market}`,
      body: `CoinDCX didn't take a stop order (${rec.exchangeStop?.lastError ?? "no reason given"}). The server still watches this trade's stop itself.`,
      tag: `stop-refused-${rec.positionId}`,
      url: "/",
    }),
});

/**
 * Closes a guarded position at `price` now (a paper one; a live one gets its
 * exchange exit too), as when its stop is hit: the breakout strategy's sale
 * on a close below the 20-day low. False if it's no longer held.
 */
export function closeServerPosition(id: string, price: number, reason: ExitReason, opts: { byApp?: boolean } = {}): boolean {
  const pos = daemonPositions.get(id);
  if (!pos || !(price > 0)) return false;
  pos.currentPrice = price;
  executeDaemonExit(pos, price, reason, opts);
  return true;
}

/** This user's trades the guardian closed (newest first). */
export function closedTradesFor(uid: string): DaemonClosedTrade[] {
  return daemonClosedTrades.filter((t) => t.userId === uid);
}

/**
 * Starts guarding a position the server's autopilot opened, and tells the
 * owner's open apps (they show it from then on).
 */
export function openServerPosition(uid: string, position: DaemonPosition, opts: { live?: boolean } = {}): void {
  // Live only when the server itself just placed and registered the order (server/liveEntry.ts).
  const pos: DaemonPosition = { ...position, userId: uid, isLiveOrder: !!opts.live, openedByServer: true };
  daemonPositions.set(pos.id, pos);
  saveDaemonStateToDisk();
  broadcastToUser(uid, { type: "POSITION_OPENED", data: pos });
  void notifyUser(uid, tradeOpenedMessage(pos, "server"));
}

/** Test hook. */
export function _resetGuardian(): void {
  daemonPositions.clear();
  daemonClosedTrades.length = 0;
}

/** What a restart would need to carry on guarding a position the same way. */
function guardStateKey(p: DaemonPosition): string {
  return [p.stopLoss, p.takeProfit, p.trailActive, p.highestPrice, p.lowestPrice, p.bankedQuantity].join("|");
}

// Evaluate all daemon positions against the latest price tick
/**
 * Judges this symbol's positions on a new price. With a quote, each is
 * judged (and a paper exit filled) at the price it could be closed at: the
 * bid for a long, the ask for a short.
 */
export function evaluateDaemonPositions(symbol: string, currentPrice: number, quote?: Quote) {
  if (daemonPositions.size === 0) return;

  for (const pos of daemonPositions.values()) {
    if (pos.symbol !== symbol) continue;

    const price = quote ? closeoutPrice(pos.direction, quote) : currentPrice;
    const before = guardStateKey(pos);
    const exitReason = applyGuardianTick(pos, price);
    if (exitReason) {
      executeDaemonExit(pos, price, exitReason);
    } else if (guardStateKey(pos) !== before) {
      // The stop, trailing state, price extremes or banked half moved: save
      // soon. A tick that only changed the price isn't worth a disk write
      // (on a Cloud Storage volume every write is an upload).
      scheduleDaemonDiskSave(10_000);
    }
  }
}

// 24/7 Background Expiry Guard: checks max holding time every 15s even if no ticks arrive
export function startExpiryGuard() {
  return setInterval(() => {
  const now = Date.now();
  for (const pos of daemonPositions.values()) {
    if (isPastHoldingTime(pos, now)) {
      executeDaemonExit(pos, pos.currentPrice || pos.entryPrice, "EXPIRY_TIME");
    }
  }
  }, 15000);
}
