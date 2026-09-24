import fs from "fs";
import path from "path";
import { Router, type Request, type Response } from "express";
import type { AuthedRequest } from "./auth";
import { applyGuardianTick, isPastHoldingTime, mergeSyncedGuardState } from "./guardianLogic";
import { getLivePosition, isOpenLivePosition, requestLiveExit } from "./liveExecution";
import { broadcastToUser } from "./realtime";
import { computeClosedTradePnl } from "../src/shared/tradeMath";
import { blendedExitPrice } from "../src/shared/exitRules";

import { validate, syncPositionsBody, closedEventsQuery } from "./validation";

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
  stopAtExit?: number;
  fillAtExit?: number;
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

// In-memory server daemon registry of active positions synced with clients
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

// Sync positions from client to server daemon
router.post("/api/daemon/sync-positions", validate({ body: syncPositionsBody }), (req: Request, res: Response) => {
  const { positions } = req.body;
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

  // Remove this user's positions that the client explicitly closed. A LIVE
  // position is never dropped this way (e.g. by a client that lost its local
  // state) — it leaves the guardian only through a real exchange exit.
  for (const [id, pos] of daemonPositions) {
    if (pos.userId === uid && !incomingIds.has(id) && !isOpenLivePosition(id)) {
      daemonPositions.delete(id);
    }
  }

  // Update or insert current positions
  for (const p of positions) {
    if (!p || typeof p.id !== "string") continue;
    if (closedPositionIds.has(p.id)) {
      rejectedResurrections.push(p.id);
      continue;
    }

    const existing = daemonPositions.get(p.id);
    if (existing && existing.userId && existing.userId !== uid) continue; // someone else's position id

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
    });
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

// Process a server-side position exit
function executeDaemonExit(pos: DaemonPosition, exitPrice: number, reason: "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "EXPIRY_TIME") {
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
    pos.bankedQuantity && pos.bankedPrice !== undefined ? { quantity: pos.bankedQuantity, price: pos.bankedPrice } : undefined
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
    stopAtExit: pos.stopLoss,
    fillAtExit: exitPrice,
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

  // Tell the owner's connected clients immediately
  broadcastToUser(pos.userId, { type: "DAEMON_POSITION_CLOSED", data: closedRecord });
}

/** What a restart would need to carry on guarding a position the same way. */
function guardStateKey(p: DaemonPosition): string {
  return [p.stopLoss, p.takeProfit, p.trailActive, p.highestPrice, p.lowestPrice, p.bankedQuantity].join("|");
}

// Evaluate all daemon positions against the latest price tick
export function evaluateDaemonPositions(symbol: string, currentPrice: number) {
  if (daemonPositions.size === 0) return;

  for (const pos of daemonPositions.values()) {
    if (pos.symbol !== symbol) continue;

    const before = guardStateKey(pos);
    const exitReason = applyGuardianTick(pos, currentPrice);
    if (exitReason) {
      executeDaemonExit(pos, currentPrice, exitReason);
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
