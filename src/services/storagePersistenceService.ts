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
  const fallback: AgentCapitalState = {
    equity: 100000,
    cash: 100000,
    dailyRealizedPnl: 0,
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY_CAPITAL);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        equity: Number(parsed.equity) || fallback.equity,
        cash: Number(parsed.cash) || fallback.cash,
        dailyRealizedPnl: Number(parsed.dailyRealizedPnl) || 0,
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
    localStorage.setItem(STORAGE_KEY_CAPITAL, JSON.stringify(capital));
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
      if (Array.isArray(parsed)) {
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

