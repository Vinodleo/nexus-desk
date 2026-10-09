import fs from "fs";
import path from "path";
import { Router, type Request, type Response } from "express";
import type { AuthedRequest } from "./auth";
import { applyGuardianTick, isPastHoldingTime, mergeSyncedGuardState } from "./guardianLogic";
import { getLivePosition, isOpenLivePosition, requestLiveExit, setExchangeStopListener, setStopSource } from "./liveExecution";
import { broadcastToUser } from "./realtime";
import { computeClosedTradePnl } from "../src/shared/tradeMath";
import { blendedExitPrice, riskAtOpen } from "../src/shared/exitRules";
import { closeoutPrice, type Quote } from "../src/shared/quotes";
import { notifyUser, tradeClosedMessage, tradeOpenedMessage } from "./push";

import { validate, syncPositionsBody, closedEventsQuery, daemonCloseBody } from "./validation";
import { slowStrategyOf } from "../src/shared/marketLimits";
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
  /** The app has synced it back at least once, so it knows about it. */
  clientSeen?: boolean;
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
  /** Positions an app said it closed, with when (appClosedIds). */
  appClosed?: [string, number][];
}

// Persistent daemon state configuration on disk
const DAEMON_STORAGE_DIR = process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const DAEMON_STORAGE_FILE = path.join(DAEMON_STORAGE_DIR, "daemon_positions_state.json");
const DAEMON_STORAGE_TMP = path.join(DAEMON_STORAGE_DIR, "daemon_positions_state.json.tmp");

// In-memory server daemon registry of active positions synced with clients
export const daemonPositions: Map<string, DaemonPosition> = new Map();
const daemonClosedTrades: DaemonClosedTrade[] = [];
let daemonLastSavedAt: string = new Date().toISOString();

// Positions an app said it closed (or dropped), with when: another device's
// older book can't bring one back. Kept two weeks, past the week an app keeps
// telling of its closes.
const appClosedIds: Map<string, number> = new Map();
const APP_CLOSED_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const APP_CLOSED_MAX = 2000;

// Positions the app said it closed, kept a few minutes: its report of the
// close (/api/daemon/close, with the price) may arrive just after the push
// that dropped them, and is still recorded.
const droppedByApp = new Map<string, { pos: DaemonPosition; at: number }>();
const DROPPED_KEEP_MS = 10 * 60 * 1000;

function pruneAppClosed(now: number): void {
  for (const [id, at] of appClosedIds) if (at < now - APP_CLOSED_KEEP_MS) appClosedIds.delete(id);
  // Oldest first (insertion order): drop the oldest past the cap.
  for (const id of appClosedIds.keys()) {
    if (appClosedIds.size <= APP_CLOSED_MAX) break;
    appClosedIds.delete(id);
  }
}
let daemonSaveTimer: NodeJS.Timeout | null = null;

// Synchronous disk save with atomic write (.tmp -> rename)
export function saveDaemonStateToDisk(): void {
  try {
    if (!fs.existsSync(DAEMON_STORAGE_DIR)) {
      fs.mkdirSync(DAEMON_STORAGE_DIR, { recursive: true });
    }
    pruneAppClosed(Date.now());
    const state: DaemonPersistedState = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      positions: Array.from(daemonPositions.values()),
      closedTrades: daemonClosedTrades.slice(0, 200),
      appClosed: [...appClosedIds],
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
        }
        if (Array.isArray(state.appClosed)) {
          for (const entry of state.appClosed) {
            if (Array.isArray(entry) && typeof entry[0] === "string" && Number.isFinite(entry[1])) appClosedIds.set(entry[0], entry[1]);
          }
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
// Positions saved before per-user tracking have no userId; the first user to
// sync claims them (this app has a single operator in practice).
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

/** A synced position opened within this long is announced as a new trade. */
const NEW_POSITION_NOTIFY_MS = 5 * 60 * 1000;

// Sync positions from client to server daemon
router.post("/api/daemon/sync-positions", validate({ body: syncPositionsBody }), (req: Request, res: Response) => {
  const { positions, closedIds } = req.body as { positions: DaemonPosition[]; closedIds?: string[] };
  if (!Array.isArray(positions)) {
    return res.status(400).json({ error: "positions array required" });
  }

  const uid = (req as AuthedRequest).user!.uid;
  const incomingIds = new Set(positions.map((p: DaemonPosition) => p.id));
  
  // Set of closed position IDs to prevent ghost resurrection of positions closed by server
  const closedPositionIds = new Set(daemonClosedTrades.map(t => t.positionId));
  const rejectedResurrections: string[] = [];

  // Claim legacy positions saved before per-user tracking.
  for (const pos of daemonPositions.values()) {
    if (!pos.userId) pos.userId = uid;
  }
  for (const t of daemonClosedTrades) {
    if (!t.userId) t.userId = uid;
  }

  // Remove this user's positions that the client closed. A LIVE position is
  // never dropped this way — it leaves the guardian only through a real
  // exchange exit.
  if (closedIds) {
    // Only the ones it says it closed: a position missing from its book may
    // be one it hasn't heard of yet (opened on another device, or by the
    // server's autopilot), so it stays guarded and the app takes it up.
    const now = Date.now();
    for (const [id, d] of droppedByApp) if (now - d.at > DROPPED_KEEP_MS) droppedByApp.delete(id);
    for (const id of closedIds) {
      if (!appClosedIds.has(id)) appClosedIds.set(id, now);
      const pos = daemonPositions.get(id);
      if (pos && pos.userId === uid && !isOpenLivePosition(id)) {
        daemonPositions.delete(id);
        droppedByApp.set(id, { pos, at: now });
      }
    }
  } else {
    // An app from before closedIds (an older version still cached): a
    // position missing from its book was closed there. Not one the server's
    // autopilot opened that the app hasn't picked up yet.
    for (const [id, pos] of daemonPositions) {
      if (pos.openedByServer && !pos.clientSeen) continue;
      if (pos.userId === uid && !incomingIds.has(id) && !isOpenLivePosition(id)) {
        daemonPositions.delete(id);
      }
    }
  }

  // Update or insert current positions
  for (const p of positions) {
    if (!p || typeof p.id !== "string") continue;
    // Closed by the guardian, or by an app: another device's older book can't bring it back.
    if (closedPositionIds.has(p.id) || (appClosedIds.has(p.id) && !daemonPositions.has(p.id))) {
      rejectedResurrections.push(p.id);
      continue;
    }

    const existing = daemonPositions.get(p.id);
    if (existing && existing.userId && existing.userId !== uid) continue; // someone else's position id
    // A position the app just opened: tell the user's devices. (Only a
    // fresh one: an old position re-sent after the server lost its state
    // isn't news.)
    if (!existing && Date.now() - Date.parse(p.openTime) < NEW_POSITION_NOTIFY_MS) {
      void notifyUser(uid, tradeOpenedMessage(p, "app"));
    }

    // A live position is guarded only while the server's registry says it's
    // open, and on the server's own quantity — never the client's claim.
    const live = getLivePosition(p.id);
    const isLive = !!live && live.status === "OPEN" && live.userId === uid;
    daemonPositions.set(p.id, {
      ...p,
      userId: uid,
      isLiveOrder: isLive,
      ...(isLive ? { quantity: live!.quantity } : {}),
      ...mergeSyncedGuardState(p.direction, p.entryPrice, existing, p),
      openedByServer: existing?.openedByServer,
      clientSeen: existing?.openedByServer ? true : undefined,
      // Set by the server when it opened a daily trade: an app that doesn't know the fields keeps them.
      ...(existing?.timeframe ? { timeframe: existing.timeframe } : {}),
      ...(existing?.strategy ? { strategy: existing.strategy } : {}),
    });
  }

  // The server's autopilot and the app's opened the same coin from the same
  // candle (each before it saw the other's): the app keeps its own, and the
  // server drops the copy the app hasn't taken.
  const appSymbols = new Map(positions.map((p: DaemonPosition) => [p.symbol, p.id]));
  for (const [id, pos] of daemonPositions) {
    if (pos.userId !== uid || !pos.openedByServer || pos.clientSeen || incomingIds.has(id)) continue;
    if (appSymbols.has(pos.symbol)) {
      daemonPositions.delete(id);
      console.log(`[Daemon Position Guardian] Dropped server-opened ${pos.symbol} (${id}): the app already holds ${appSymbols.get(pos.symbol)}.`);
    }
  }

  // Persist updated positions immediately to disk
  saveDaemonStateToDisk();

  res.json({
    success: true,
    trackedCount: daemonPositions.size,
    closedEventsCount: daemonClosedTrades.length,
    rejectedResurrections,
    lastSavedAt: daemonLastSavedAt,
  });
});

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

// A close the app made (by hand, or on its own prices): the guardian closes
// the position and records it, so its closed trades hold every trade (and a
// live trade's exchange exit goes out from here). One already closed answers
// with its record; one the guardian never held, 404.
router.post("/api/daemon/close", validate({ body: daemonCloseBody }), (req: Request, res: Response) => {
  const uid = (req as AuthedRequest).user!.uid;
  const { positionId, price, reason } = req.body as { positionId: string; price: number; reason: ExitReason };
  let pos = daemonPositions.get(positionId);
  const dropped = droppedByApp.get(positionId);
  droppedByApp.delete(positionId);
  if (!pos && dropped && dropped.pos.userId === uid && Date.now() - dropped.at <= DROPPED_KEEP_MS) {
    // Dropped by the push that beat this report here: back in, to be closed and recorded.
    pos = dropped.pos;
    daemonPositions.set(pos.id, pos);
  }
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
 * owner's open apps. It stays guarded until the app has it (see the sync).
 */
export function openServerPosition(uid: string, position: DaemonPosition, opts: { live?: boolean } = {}): void {
  // Live only when the server itself just placed and registered the order (server/liveEntry.ts).
  const pos: DaemonPosition = { ...position, userId: uid, isLiveOrder: !!opts.live, openedByServer: true, clientSeen: false };
  daemonPositions.set(pos.id, pos);
  saveDaemonStateToDisk();
  broadcastToUser(uid, { type: "POSITION_OPENED", data: pos });
  void notifyUser(uid, tradeOpenedMessage(pos, "server"));
}

/** Test hook. */
export function _resetGuardian(): void {
  daemonPositions.clear();
  daemonClosedTrades.length = 0;
  appClosedIds.clear();
  droppedByApp.clear();
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
