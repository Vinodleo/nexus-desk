import { ExperienceVector, Position, HistoricalTrade, PromotedLabModel } from "../types";
import { generateInitialExperienceDatabase } from "./experienceMemory";
import type { SkipCounts } from "./scanOutcome";

const STORAGE_KEY_EXPERIENCES = "nexus_agent_experiences_inr_v4";
const STORAGE_KEY_STATS = "nexus_agent_stats_inr_v4";
const STORAGE_KEY_POSITIONS = "nexus_agent_positions_inr_v5";
const STORAGE_KEY_CAPITAL = "nexus_agent_capital_inr_v4";
const STORAGE_KEY_CLOSED_TRADES = "nexus_agent_closed_trades_inr_v4";
const STORAGE_KEY_MODEL_ACCURACY = "nexus_agent_model_accuracy_inr_v4";
const STORAGE_KEY_PROMOTED_LAB_MODEL = "nexus_agent_promoted_lab_model_inr_v4";
const STORAGE_KEY_QUARANTINES = "nexus_agent_quarantines_inr_v1";
const STORAGE_KEY_LOSS_STREAK_SINCE = "nexus_loss_streak_since_v1";

/** When the kill switch was last turned off: losses before this don't count toward the next trip. */
export function loadLossStreakSince(): number {
  try {
    return Number(localStorage.getItem(STORAGE_KEY_LOSS_STREAK_SINCE)) || 0;
  } catch {
    return 0;
  }
}

export function saveLossStreakSince(ms: number): void {
  try {
    localStorage.setItem(STORAGE_KEY_LOSS_STREAK_SINCE, String(ms));
  } catch {}
}
export interface SymbolQuarantineRecord {
  symbol: string;
  quarantinedUntilMs: number;
  reason: string;
  consecutiveLosses: number;
  lastLossTimestamp?: string;
}

export function loadStoredQuarantines(): Record<string, SymbolQuarantineRecord> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_QUARANTINES);
    if (raw) {
      const parsed: Record<string, SymbolQuarantineRecord> = JSON.parse(raw);
      const now = Date.now();
      const valid: Record<string, SymbolQuarantineRecord> = {};
      for (const [sym, rec] of Object.entries(parsed)) {
        if (rec && rec.quarantinedUntilMs > now) {
          valid[sym] = rec;
        }
      }
      return valid;
    }
  } catch (err) {
    console.warn("Failed to load quarantines from LocalStorage:", err);
  }
  return {};
}

export function saveStoredQuarantines(quarantines: Record<string, SymbolQuarantineRecord>): void {
  try {
    const now = Date.now();
    const clean: Record<string, SymbolQuarantineRecord> = {};
    for (const [sym, rec] of Object.entries(quarantines)) {
      if (rec && rec.quarantinedUntilMs > now) {
        clean[sym] = rec;
      }
    }
    localStorage.setItem(STORAGE_KEY_QUARANTINES, JSON.stringify(clean));
  } catch (err) {
    console.warn("Failed to save quarantines to LocalStorage:", err);
  }
}

export function loadStoredPromotedLabModel(): PromotedLabModel | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PROMOTED_LAB_MODEL);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.accuracyPct) {
        return parsed as PromotedLabModel;
      }
    }
  } catch (err) {
    console.warn("Failed to load promoted lab model from LocalStorage:", err);
  }
  return null;
}

export function saveStoredPromotedLabModel(model: PromotedLabModel | null): void {
  try {
    if (model) {
      localStorage.setItem(STORAGE_KEY_PROMOTED_LAB_MODEL, JSON.stringify(model));
    } else {
      localStorage.removeItem(STORAGE_KEY_PROMOTED_LAB_MODEL);
    }
  } catch (err) {
    console.warn("Failed to save promoted lab model to LocalStorage:", err);
  }
}

export interface LearnedModelAccuracy {
  accuracyPct: number;
  winRatePct: number;
  sharpeRatio: number;
  datasetName: string;
  lastUpdated: string;
  totalCandlesEvaluated: number;
}

export function loadStoredModelAccuracy(): LearnedModelAccuracy {
  const fallback: LearnedModelAccuracy = {
    accuracyPct: 76.7,
    winRatePct: 61.8,
    sharpeRatio: 1.92,
    datasetName: "Baseline Benchmark",
    lastUpdated: new Date().toISOString(),
    totalCandlesEvaluated: 4800,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MODEL_ACCURACY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        accuracyPct: Number(parsed.accuracyPct) || fallback.accuracyPct,
        winRatePct: Number(parsed.winRatePct) || fallback.winRatePct,
        sharpeRatio: Number(parsed.sharpeRatio) || fallback.sharpeRatio,
        datasetName: parsed.datasetName || fallback.datasetName,
        lastUpdated: parsed.lastUpdated || fallback.lastUpdated,
        totalCandlesEvaluated: Number(parsed.totalCandlesEvaluated) || fallback.totalCandlesEvaluated,
      };
    }
  } catch (err) {
    console.warn("Failed to load model accuracy from LocalStorage:", err);
  }
  return fallback;
}

export function saveStoredModelAccuracy(accuracy: LearnedModelAccuracy): void {
  try {
    localStorage.setItem(STORAGE_KEY_MODEL_ACCURACY, JSON.stringify(accuracy));
  } catch (err) {
    console.warn("Failed to save model accuracy to LocalStorage:", err);
  }
}

export interface AgentLearningStats {
  selfApprovedCount: number;
  selfApprovedWins: number;
  selfApprovedLosses: number;
  lastUpdated: string;
}

export interface AgentCapitalState {
  equity: number;
  cash: number;
  dailyRealizedPnl: number;
  allTimeRealizedPnl: number;
  istDateString?: string;
}

/**
 * Load stored experience vectors from Browser LocalStorage.
 * Falls back to the pre-trained 420 base vectors if no local storage exists yet.
 */
export function loadStoredExperiences(): ExperienceVector[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_EXPERIENCES);
    if (!raw) {
      return generateInitialExperienceDatabase();
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch (err) {
    console.warn("Failed to read experiences from LocalStorage, loading baseline:", err);
  }
  return generateInitialExperienceDatabase();
}

/**
 * Persist experience vectors to Browser LocalStorage.
 */
export function saveStoredExperiences(experiences: ExperienceVector[]): void {
  try {
    // Keep the most recent 1,200 experience vectors to prevent local storage quota saturation
    const bounded = experiences.slice(0, 1200);
    localStorage.setItem(STORAGE_KEY_EXPERIENCES, JSON.stringify(bounded));
  } catch (err) {
    console.warn("Failed to save experiences to LocalStorage:", err);
  }
}

/**
 * Load agent track record stats from Browser LocalStorage.
 */
export function loadStoredStats(): AgentLearningStats {
  // A fresh desk starts with no track record. (This used to default to a
  // made-up 18 trades / 12 wins / 6 losses.)
  const fallback: AgentLearningStats = {
    selfApprovedCount: 0,
    selfApprovedWins: 0,
    selfApprovedLosses: 0,
    lastUpdated: new Date().toISOString(),
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY_STATS);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        selfApprovedCount: Number(parsed.selfApprovedCount) || fallback.selfApprovedCount,
        selfApprovedWins: Number(parsed.selfApprovedWins) || fallback.selfApprovedWins,
        selfApprovedLosses: Number(parsed.selfApprovedLosses) || fallback.selfApprovedLosses,
        lastUpdated: parsed.lastUpdated || fallback.lastUpdated,
      };
    }
  } catch (err) {
    console.warn("Failed to load stats from LocalStorage:", err);
  }
  return fallback;
}

/**
 * Persist agent track record stats to Browser LocalStorage.
 */
export function saveStoredStats(stats: AgentLearningStats): void {
  try {
    localStorage.setItem(STORAGE_KEY_STATS, JSON.stringify(stats));
  } catch (err) {
    console.warn("Failed to save stats to LocalStorage:", err);
  }
}

/**
 * Load capital & realized PnL state from LocalStorage.
 */
export function loadStoredCapital(): AgentCapitalState {
  const todayIST = getCurrentISTDateString();
  const fallback: AgentCapitalState = {
    equity: 100000,
    cash: 100000,
    dailyRealizedPnl: 0,
    allTimeRealizedPnl: 0,
    istDateString: todayIST,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CAPITAL);
    if (raw) {
      const parsed = JSON.parse(raw);
      const savedDate = parsed.istDateString;

      return {
        equity: Number(parsed.equity) || fallback.equity,
        // The paper book never debits cash when a position opens, so cash and
        // equity always move together. Older builds inflated cash on
        // server-guardian closes; re-deriving it from equity repairs that.
        cash: Number(parsed.equity) || fallback.cash,
        // Reset daily PNL to 0 if it's a new day
        dailyRealizedPnl: savedDate === todayIST ? (Number(parsed.dailyRealizedPnl) || 0) : 0,
        allTimeRealizedPnl:
          parsed.allTimeRealizedPnl !== undefined
            ? Number(parsed.allTimeRealizedPnl)
            : Number(parsed.equity)
            ? Number(parsed.equity) - 100000
            : 0,
        istDateString: todayIST,
      };
    }
  } catch (err) {
    console.warn("Failed to load capital from LocalStorage:", err);
  }
  return fallback;
}

/**
 * Persist capital state.
 */
export function saveStoredCapital(capital: AgentCapitalState): void {
  try {
    const toSave = { ...capital, istDateString: getCurrentISTDateString() };
    localStorage.setItem(STORAGE_KEY_CAPITAL, JSON.stringify(toSave));
  } catch (err) {
    console.warn("Failed to save capital to LocalStorage:", err);
  }
}

/**
 * Clear local memory and reset back to initial 420 base vectors.
 */
export function resetStoredExperiencesToBaseline(): ExperienceVector[] {
  try {
    localStorage.removeItem(STORAGE_KEY_EXPERIENCES);
    localStorage.removeItem(STORAGE_KEY_STATS);
    localStorage.removeItem(STORAGE_KEY_POSITIONS);
    localStorage.removeItem(STORAGE_KEY_CAPITAL);
    localStorage.removeItem(STORAGE_KEY_CLOSED_TRADES);
    localStorage.removeItem("nexus_agent_daily_telemetry_ist_v1");
  } catch (err) {
    console.warn("Failed to reset LocalStorage:", err);
  }
  return generateInitialExperienceDatabase();
}

/**
 * Daily Telemetry (24 hours: 12:00 AM to 11:59 PM IST)
 */
export interface DailySampleTelemetry {
  istDateString: string; // YYYY-MM-DD in Asia/Kolkata (IST)
  /** Coin-candles the scanner looked at today. */
  analyzedCount: number;
  /** Of those, how many became proposals. */
  selectedCount: number;
  /** Of those, how many were skipped (see skipReasons). */
  rejectedCount: number;
  /** Why they were skipped, counted by reason. */
  skipReasons: SkipCounts;
  /** Proposals you skipped in the queue. */
  skippedByYou: number;
}

const STORAGE_KEY_DAILY_TELEMETRY = "nexus_agent_daily_telemetry_ist_v2";

/**
 * Returns current date string in IST (Asia/Kolkata timezone: UTC+5:30)
 * Format: YYYY-MM-DD
 */
export function getCurrentISTDateString(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

/**
 * Create initial empty telemetry record for a new IST trading day
 */
export function getInitialDailyTelemetry(istDate = getCurrentISTDateString()): DailySampleTelemetry {
  return {
    istDateString: istDate,
    analyzedCount: 0,
    selectedCount: 0,
    rejectedCount: 0,
    skipReasons: {},
    skippedByYou: 0,
  };
}

/**
 * Load daily sample telemetry. If the stored record is from a previous IST day
 * (i.e. cross 12:00 AM IST midnight), it automatically resets to 0.
 */
export function loadDailySampleTelemetry(): DailySampleTelemetry {
  const todayIST = getCurrentISTDateString();
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DAILY_TELEMETRY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.istDateString === todayIST) {
        return {
          istDateString: todayIST,
          analyzedCount: Number(parsed.analyzedCount) || 0,
          selectedCount: Number(parsed.selectedCount) || 0,
          rejectedCount: Number(parsed.rejectedCount) || 0,
          skipReasons: parsed.skipReasons && typeof parsed.skipReasons === "object" ? parsed.skipReasons : {},
          skippedByYou: Number(parsed.skippedByYou) || 0,
        };
      }
    }
  } catch (err) {
    console.warn("Failed to load daily telemetry from LocalStorage:", err);
  }
  // New day or first load: reset to 0 for today
  const fresh = getInitialDailyTelemetry(todayIST);
  saveDailySampleTelemetry(fresh);
  return fresh;
}

/**
 * Persist daily sample telemetry to LocalStorage.
 */
export function saveDailySampleTelemetry(data: DailySampleTelemetry): void {
  try {
    localStorage.setItem(STORAGE_KEY_DAILY_TELEMETRY, JSON.stringify(data));
  } catch (err) {
    console.warn("Failed to save daily telemetry to LocalStorage:", err);
  }
}

/**
 * Baseline recent closed trades for the Book tab demonstration and record
 */
export function getBaselineClosedTrades(): HistoricalTrade[] {
  return [];
}

/**
 * Load open positions from LocalStorage, so unrealized P&L and open trades
 * survive a page reload/refresh instead of vanishing with in-memory state.
 */
export function loadStoredPositions(): Position[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_POSITIONS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn("Failed to load positions from LocalStorage:", err);
  }
  return [];
}

/**
 * Persist open positions to LocalStorage.
 * Called on every change so a refresh — intentional or the browser
 * reclaiming a backgrounded tab — never silently drops a position
 * the app still thinks is open.
 */
export function saveStoredPositions(positions: Position[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_POSITIONS, JSON.stringify(positions));
  } catch (err) {
    console.warn("Failed to save positions to LocalStorage:", err);
  }
}

export const MAX_STORED_TRADES = 1000;

/**
 * Fixes trades saved by older versions so the Book shows all of them:
 * trades sharing an id (two closes in the same millisecond) get distinct
 * ids, and guardian-closed trades saved without a close time get it from
 * their ISO timestamp (they sorted to the bottom, under "Earlier").
 */
export function repairClosedTrades(trades: HistoricalTrade[]): HistoricalTrade[] {
  const seen = new Map<string, number>();
  return trades.map((t) => {
    let fixed = t;
    const n = seen.get(t.id) ?? 0;
    seen.set(t.id, n + 1);
    if (n > 0) fixed = { ...fixed, id: `${t.id}-${n + 1}` };
    if (fixed.closedAtMs === undefined && typeof fixed.closedAt === "string") {
      const ms = Date.parse(fixed.closedAt);
      if (Number.isFinite(ms)) {
        const hhmm = (v: number) => new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const opened = typeof fixed.openedAt === "string" ? Date.parse(fixed.openedAt) : NaN;
        fixed = {
          ...fixed,
          closedAtMs: ms,
          closedAt: hhmm(ms),
          ...(Number.isFinite(opened) ? { openedAtMs: opened, openedAt: hhmm(opened) } : {}),
        };
      }
    }
    return fixed;
  });
}

export function loadStoredClosedTrades(): HistoricalTrade[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CLOSED_TRADES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed)) {
        // Filter out old dummy placeholders and any legacy USDT/BTCUSDT test trades
        const filtered = parsed.filter(t => !t.id.startsWith("trade-hist-") && t.symbol !== "BTCUSDT" && !t.symbol.endsWith("USDT"));
        return repairClosedTrades(filtered);
      }
    }
  } catch (err) {
    console.warn("Failed to load closed trades from LocalStorage:", err);
  }
  return getBaselineClosedTrades();
}

/**
 * Persist closed trades history to LocalStorage.
 */
export function saveStoredClosedTrades(trades: HistoricalTrade[]): void {
  try {
    // Keep the most recent 1,000 trades (about 0.5 MB).
    const bounded = trades.slice(0, MAX_STORED_TRADES);
    localStorage.setItem(STORAGE_KEY_CLOSED_TRADES, JSON.stringify(bounded));
  } catch (err) {
    console.warn("Failed to save closed trades to LocalStorage:", err);
  }
}

import { auth, db } from "./firebase";
import { doc, getDoc, setDoc, collection, getDocs, writeBatch, deleteDoc } from "firebase/firestore";

export async function syncToFirebase(userId: string) {
  try {
    const userRef = doc(db, "users", userId);

    const stats = loadStoredStats();
    const capital = loadStoredCapital();
    const accuracy = loadStoredModelAccuracy();
    const promotedModel = loadStoredPromotedLabModel();
    const dailyTelemetry = loadDailySampleTelemetry();

    // uid, email and createdAt are fixed once the profile exists (see
    // firestore.rules), so only send them when creating it.
    const existingProfile = await getDoc(userRef);
    const identity = existingProfile.exists()
      ? {}
      : { uid: userId, email: auth.currentUser?.email ?? null, createdAt: new Date().toISOString() };

    await setDoc(userRef, {
      ...identity,
      ...stats,
      ...capital,
      accuracyPct: accuracy.accuracyPct || 0,
      promotedLabModel: promotedModel || null,
      dailyTelemetry: dailyTelemetry || null
    }, { merge: true });

    const experiences = loadStoredExperiences();
    if (experiences.length > 0) {
      const expBatch = writeBatch(db);
      experiences.slice(0, 450).forEach(exp => {
        const expRef = doc(db, "users", userId, "experiences", exp.id);
        expBatch.set(expRef, { ...exp, userId });
      });
      await expBatch.commit();
    }

    const trades = loadStoredClosedTrades();
    if (trades.length > 0) {
      const tradesBatch = writeBatch(db);
      trades.slice(0, 450).forEach(trade => {
        const tradeRef = doc(db, "users", userId, "closedTrades", trade.id);
        tradesBatch.set(tradeRef, { ...trade, userId });
      });
      await tradesBatch.commit();
    }

    // Synchronize active open positions to cloud
    const positions = loadStoredPositions();
    const posCollection = collection(db, "users", userId, "activePositions");
    const existingPosSnap = await getDocs(posCollection);
    const currentPosIds = new Set(positions.map(p => p.id));
    
    // Prune closed positions from Firestore
    if (!existingPosSnap.empty) {
      const deleteBatch = writeBatch(db);
      let needsPrune = false;
      existingPosSnap.docs.forEach(docSnap => {
        if (!currentPosIds.has(docSnap.id)) {
          deleteBatch.delete(docSnap.ref);
          needsPrune = true;
        }
      });
      if (needsPrune) {
        await deleteBatch.commit();
      }
    }

    // Upsert current open positions
    if (positions.length > 0) {
      const posBatch = writeBatch(db);
      positions.forEach(pos => {
        const posRef = doc(db, "users", userId, "activePositions", pos.id);
        posBatch.set(posRef, {
          id: pos.id,
          userId,
          symbol: pos.symbol,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          currentPrice: pos.currentPrice || pos.entryPrice,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          quantity: pos.quantity,
          moneyPlaced: pos.entryPrice * pos.quantity,
          trailActive: Boolean(pos.trailActive),
          trailMode: pos.trailMode || "DYNAMIC_RATIO",
          highestPrice: pos.highestPrice || pos.entryPrice,
          lowestPrice: pos.lowestPrice || pos.entryPrice,
          openTime: pos.openTime,
          setupName: pos.setupName || "Statistical Trailing System",
        });
      });
      await posBatch.commit();
    }

    console.log("Successfully synced to Firebase cloud.");
  } catch (err) {
    console.error("Firebase sync error", err);
  }
}

export async function syncFromFirebase(userId: string): Promise<boolean> {
  try {
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);

    if (userSnap.exists()) {
      const data = userSnap.data();

      saveStoredStats({
        selfApprovedCount: data.selfApprovedCount || 0,
        selfApprovedWins: data.selfApprovedWins || 0,
        selfApprovedLosses: data.selfApprovedLosses || 0,
        lastUpdated: data.lastUpdated || new Date().toISOString()
      });

      saveStoredCapital({
        equity: data.equity || 100000,
        cash: data.cash || 100000,
        dailyRealizedPnl: data.dailyRealizedPnl || 0,
        allTimeRealizedPnl: data.allTimeRealizedPnl || 0
      });

      if (data.accuracyPct) {
        saveStoredModelAccuracy({
          accuracyPct: data.accuracyPct,
          datasetName: "Cloud Synced",
          winRatePct: 0,
          sharpeRatio: 0,
          totalCandlesEvaluated: 0,
          lastUpdated: data.lastUpdated
        });
      }

      if (data.promotedLabModel) {
        saveStoredPromotedLabModel(data.promotedLabModel);
      }

      if (data.dailyTelemetry) {
        saveDailySampleTelemetry(data.dailyTelemetry);
      }
    }

    const expSnap = await getDocs(collection(db, "users", userId, "experiences"));
    if (!expSnap.empty) {
      const exps = expSnap.docs.map(d => d.data() as ExperienceVector);
      saveStoredExperiences(exps);
    }

    const tradesSnap = await getDocs(collection(db, "users", userId, "closedTrades"));
    if (!tradesSnap.empty) {
      const trades = tradesSnap.docs.map(d => d.data() as HistoricalTrade);
      saveStoredClosedTrades(trades);
    }

    // Hydrate active positions from cloud
    const posSnap = await getDocs(collection(db, "users", userId, "activePositions"));
    if (!posSnap.empty) {
      const cloudPositions = posSnap.docs.map(d => d.data() as Position);
      if (cloudPositions.length > 0) {
        saveStoredPositions(cloudPositions);
      }
    }

    return true;
  } catch (err) {
    console.error("Firebase load error", err);
    return false;
  }
}

// Exchange keys are held only on the server now. Earlier builds wrote them to
// users/{uid}/credentials/exchangeKeys in plain text; these helpers let the
// user find and delete that legacy copy.
export async function hasLegacyExchangeKeys(userId: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, "users", userId, "credentials", "exchangeKeys"));
    return snap.exists();
  } catch (err) {
    console.error("Failed to check legacy exchange keys in Firebase:", err);
    return false;
  }
}

export async function deleteLegacyExchangeKeys(userId: string): Promise<boolean> {
  try {
    await deleteDoc(doc(db, "users", userId, "credentials", "exchangeKeys"));
    return true;
  } catch (err) {
    console.error("Failed to delete legacy exchange keys from Firebase:", err);
    return false;
  }
}
