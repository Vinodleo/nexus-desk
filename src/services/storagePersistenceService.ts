import { ExperienceVector, Position, HistoricalTrade, PromotedLabModel } from "../types";
import { generateInitialExperienceDatabase } from "./experienceMemory";

const STORAGE_KEY_EXPERIENCES = "nexus_agent_experiences_inr_v4";
const STORAGE_KEY_STATS = "nexus_agent_stats_inr_v4";
const STORAGE_KEY_POSITIONS = "nexus_agent_positions_inr_v5";
const STORAGE_KEY_CAPITAL = "nexus_agent_capital_inr_v4";
const STORAGE_KEY_CLOSED_TRADES = "nexus_agent_closed_trades_inr_v4";
const STORAGE_KEY_MODEL_ACCURACY = "nexus_agent_model_accuracy_inr_v4";
const STORAGE_KEY_PROMOTED_LAB_MODEL = "nexus_agent_promoted_lab_model_inr_v4";

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
  const fallback: AgentLearningStats = {
    selfApprovedCount: 18,
    selfApprovedWins: 12,
    selfApprovedLosses: 6,
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
        cash: Number(parsed.cash) || fallback.cash,
        // Reset daily PNL to 0 if it's a new day
        dailyRealizedPnl: savedDate === todayIST ? (Number(parsed.dailyRealizedPnl) || 0) : 0,
        allTimeRealizedPnl: parsed.allTimeRealizedPnl !== undefined ? Number(parsed.allTimeRealizedPnl) : (Number(parsed.equity) ? Number(parsed.equity) - 100000 : 0),
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
  analyzedCount: number;
  selectedCount: number;
  rejectedCount: number;
  rejectionBreakdown: {
    metaHurdle: number;
    riskEngine: number;
    regimeFilter: number;
    supervisorVeto: number;
  };
}

const STORAGE_KEY_DAILY_TELEMETRY = "nexus_agent_daily_telemetry_ist_v1";

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
    rejectionBreakdown: {
      metaHurdle: 0,
      riskEngine: 0,
      regimeFilter: 0,
      supervisorVeto: 0,
    },
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
          rejectionBreakdown: {
            metaHurdle: Number(parsed.rejectionBreakdown?.metaHurdle) || 0,
            riskEngine: Number(parsed.rejectionBreakdown?.riskEngine) || 0,
            regimeFilter: Number(parsed.rejectionBreakdown?.regimeFilter) || 0,
            supervisorVeto: Number(parsed.rejectionBreakdown?.supervisorVeto) || 0,
          },
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
 * Load closed trades history from LocalStorage or return baseline.
 */
export function loadStoredClosedTrades(): HistoricalTrade[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CLOSED_TRADES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed)) {
        // Filter out old dummy placeholders that might be stuck in the user's local storage
        const filtered = parsed.filter(t => !t.id.startsWith("trade-hist-"));
        if (filtered.length > 0) {
          return filtered;
        }
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
    // Keep the most recent 100 trades
    const bounded = trades.slice(0, 100);
    localStorage.setItem(STORAGE_KEY_CLOSED_TRADES, JSON.stringify(bounded));
  } catch (err) {
    console.warn("Failed to save closed trades to LocalStorage:", err);
  }
}


import { auth, db } from "./firebase";
import { doc, getDoc, setDoc, collection, getDocs, writeBatch } from "firebase/firestore";

export async function syncToFirebase(userId: string) {
  try {
    const userRef = doc(db, "users", userId);
    
    const stats = loadStoredStats();
    const capital = loadStoredCapital();
    const accuracy = loadStoredModelAccuracy();
    const promotedModel = loadStoredPromotedLabModel();
    const dailyTelemetry = loadDailySampleTelemetry();

    await setDoc(userRef, {
      uid: userId,
      email: auth.currentUser?.email || "",
      createdAt: new Date().toISOString(),
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
    
    return true;
  } catch (err) {
    console.error("Firebase load error", err);
    return false;
  }
}

export async function fetchLeaderboard() {
  try {
    const usersRef = collection(db, "users");
    const snapshot = await getDocs(usersRef);
    const leaderboard: any[] = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // Mask email for anonymity
      const maskedEmail = data.email 
        ? data.email.split('@')[0].slice(0, 3) + "***@" + data.email.split('@')[1] 
        : "Anonymous";
      
      leaderboard.push({
        uid: data.uid,
        maskedEmail: maskedEmail,
        displayName: data.displayName || "Operator-" + data.uid.substring(0, 4),
        accuracyPct: data.accuracyPct || 0,
        equity: data.equity || 100000,
        dailyRealizedPnl: data.dailyRealizedPnl || 0,
        selfApprovedWins: data.selfApprovedWins || 0,
        selfApprovedLosses: data.selfApprovedLosses || 0,
      });
    });
    
    // Sort by equity descending
    return leaderboard.sort((a, b) => b.equity - a.equity);
  } catch (error) {
    console.error("Failed to fetch leaderboard", error);
    return [];
  }
}


export async function saveExchangeKeys(userId: string, exchangeId: string, apiKey: string, apiSecret: string) {
  try {
    const keysRef = doc(db, "users", userId, "credentials", "exchangeKeys");
    const updatePayload = {
      [exchangeId]: {
        apiKey,
        apiSecret,
        updatedAt: new Date().toISOString()
      }
    };
    await setDoc(keysRef, updatePayload, { merge: true });
    return true;
  } catch (err) {
    console.error("Failed to save exchange keys to Firebase:", err);
    return false;
  }
}

export async function loadExchangeKeys(userId: string) {
  try {
    const keysRef = doc(db, "users", userId, "credentials", "exchangeKeys");
    const snap = await getDoc(keysRef);
    if (snap.exists()) {
      return snap.data();
    }
    return null;
  } catch (err) {
    console.error("Failed to load exchange keys from Firebase:", err);
    return null;
  }
}
