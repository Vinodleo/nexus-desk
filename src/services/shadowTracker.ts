import { holdMinutesFor } from "../shared/coinHolds";
import type { MarketBar, RegimeType, StrategySetup, TradeDirection } from "../types";
import type { SkipReason } from "./scanOutcome";
import { SIGNAL_INTERVAL_MS } from "./liveMarketStreamService";

// Shadow tracking: every setup the scanner finds, taken or not, is followed
// on real candles until it would have hit its target or its stop (or timed
// out). Comparing the skipped ones with the proposed ones shows whether a
// filter is saving you from losers or costing you winners.

export type ShadowStatus = "open" | "target" | "stop" | "expired";
export type ShadowKind = SkipReason | "proposed";

export interface ShadowSignal {
  id: string;
  symbol: string;
  direction: TradeDirection;
  setupName: string;
  family: string;
  horizon: "intraday" | "swing";
  /** Why it wasn't proposed, or "proposed". */
  kind: ShadowKind;
  /** The scanner's raw confidence score at the signal, before calibration. */
  confidence?: number;
  /** What produced that score; absent on older records, which were all "heuristic". */
  scorer?: "heuristic" | "tfjs";
  /**
   * Version of the rule-based score's formula (see HEURISTIC_SCORE_VERSION in
   * calibration). Absent on records from before version 2.
   */
  scoreVersion?: number;
  /** The Lab model's inputs at the signal (metaFeatures), for online learning. */
  features?: number[];
  /** Market regime at the signal, and the setup's indicator readings: the trade memory matches on these. */
  regime?: RegimeType;
  setupFeatures?: { adx: number; rsi: number; volumeSurgeRatio: number; vwapDistancePercent: number };
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Close time of the candle the signal came from; tracking starts here. */
  signalTime: number;
  /** Tracking stops here, like a position's time limit. */
  expiresAt: number;
  status: ShadowStatus;
  exitPrice?: number;
  resolvedAt?: number;
  /** Result in R (multiples of the stop distance), after round-trip fees. */
  r?: number;
}

/** Round-trip fees as a share of the entry price (CoinDCX taker, both sides). */
export const ROUND_TRIP_FEE = 0.001;
/** Enough history for win-chance calibration, still small in localStorage. */
const MAX_KEPT = 1500;
const STORAGE_KEY = "nexus_shadow_signals_v1";

export interface ShadowContext {
  confidence?: number;
  scorer?: "heuristic" | "tfjs";
  scoreVersion?: number;
  features?: number[];
  regime?: RegimeType;
}

export function shadowFromSetup(setup: StrategySetup, kind: ShadowKind, signalTime: number, ctx: ShadowContext = {}): ShadowSignal {
  const horizon = setup.horizon === "swing" ? "swing" : "intraday";
  const { confidence, scorer, scoreVersion, features, regime } = ctx;
  const f = setup.features;
  return {
    id: `${setup.symbol}|${setup.name}|${signalTime}`,
    symbol: setup.symbol,
    direction: setup.direction,
    setupName: setup.name,
    family: setup.family,
    horizon,
    kind,
    confidence,
    ...(scorer ? { scorer } : {}),
    ...(scoreVersion !== undefined ? { scoreVersion } : {}),
    ...(features ? { features } : {}),
    ...(regime ? { regime } : {}),
    ...(f
      ? { setupFeatures: { adx: f.adx, rsi: f.rsi, volumeSurgeRatio: f.volumeSurgeRatio, vwapDistancePercent: f.vwapDistancePercent } }
      : {}),
    entryPrice: setup.entryPrice,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    signalTime,
    // Followed as long as a real trade from it would run (4 hours for a coin).
    expiresAt: signalTime + holdMinutesFor(setup) * 60 * 1000,
    status: "open",
  };
}

function resultR(s: ShadowSignal, exit: number): number {
  const risk = Math.abs(s.entryPrice - s.stopLoss);
  if (risk <= 0) return 0;
  const move = s.direction === "LONG" ? exit - s.entryPrice : s.entryPrice - exit;
  return (move - s.entryPrice * ROUND_TRIP_FEE) / risk;
}

/**
 * Walks the candles after the signal. The first candle to reach the stop or
 * the target decides it; if one candle reaches both, it counts as the stop
 * (we can't tell which came first, so assume the worse). Past the time limit
 * it closes at that candle's close.
 */
export function resolveShadow(s: ShadowSignal, bars: MarketBar[], nowMs: number = Date.now()): ShadowSignal {
  if (s.status !== "open") return s;
  const isLong = s.direction === "LONG";
  for (const b of bars) {
    const open = b.timestampMs;
    if (open === undefined || open < s.signalTime) continue;
    const close = open + SIGNAL_INTERVAL_MS;
    if (open >= s.expiresAt) {
      const prev = [...bars].reverse().find((x) => (x.timestampMs ?? 0) < s.expiresAt && (x.timestampMs ?? 0) >= s.signalTime);
      const exit = prev?.close ?? s.entryPrice;
      return { ...s, status: "expired", exitPrice: exit, resolvedAt: s.expiresAt, r: resultR(s, exit) };
    }
    const hitStop = isLong ? b.low <= s.stopLoss : b.high >= s.stopLoss;
    const hitTarget = isLong ? b.high >= s.takeProfit : b.low <= s.takeProfit;
    if (hitStop) return { ...s, status: "stop", exitPrice: s.stopLoss, resolvedAt: close, r: resultR(s, s.stopLoss) };
    if (hitTarget) return { ...s, status: "target", exitPrice: s.takeProfit, resolvedAt: close, r: resultR(s, s.takeProfit) };
  }
  // Time's up but no candle past the limit arrived (e.g. data gap): close at the last one.
  if (nowMs >= s.expiresAt + SIGNAL_INTERVAL_MS) {
    const last = [...bars].reverse().find((x) => (x.timestampMs ?? 0) >= s.signalTime && (x.timestampMs ?? 0) < s.expiresAt);
    if (last) return { ...s, status: "expired", exitPrice: last.close, resolvedAt: s.expiresAt, r: resultR(s, last.close) };
  }
  return s;
}

export interface ShadowSummaryRow {
  kind: ShadowKind;
  tracked: number;
  resolved: number;
  /** Share of resolved signals that reached the target. */
  targetPct: number | null;
  /** Average result in R over resolved signals. */
  avgR: number | null;
}

export function summarizeShadows(list: ShadowSignal[]): ShadowSummaryRow[] {
  const byKind = new Map<ShadowKind, ShadowSignal[]>();
  for (const s of list) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s]);
  return [...byKind.entries()]
    .map(([kind, items]) => {
      const done = items.filter((s) => s.status !== "open");
      const hits = done.filter((s) => s.status === "target").length;
      return {
        kind,
        tracked: items.length,
        resolved: done.length,
        targetPct: done.length > 0 ? Math.round((hits / done.length) * 100) : null,
        avgR: done.length > 0 ? done.reduce((a, s) => a + (s.r ?? 0), 0) / done.length : null,
      };
    })
    .sort((a, b) => (a.kind === "proposed" ? -1 : b.kind === "proposed" ? 1 : b.tracked - a.tracked));
}

/**
 * Adds new signals to a list (one per setup per candle, so repeats of a
 * known one are ignored), newest first, keeping at most `max`.
 */
export function mergeShadows(existing: ShadowSignal[], fresh: ShadowSignal[], max: number = MAX_KEPT): ShadowSignal[] {
  const known = new Set(existing.map((s) => s.id));
  const added = fresh.filter((s) => {
    if (known.has(s.id)) return false;
    known.add(s.id);
    return true;
  });
  if (added.length === 0) return existing;
  return [...added, ...existing].sort((a, b) => b.signalTime - a.signalTime).slice(0, max);
}

/** Resolves open signals against each coin's candles. Returns the same list when nothing changed. */
export function resolveShadows(list: ShadowSignal[], getBars: (symbol: string) => MarketBar[] | null, nowMs: number = Date.now()): ShadowSignal[] {
  let changed = false;
  const next = list.map((s) => {
    if (s.status !== "open") return s;
    const bars = getBars(s.symbol);
    if (!bars) return s;
    const resolved = resolveShadow(s, bars, nowMs);
    if (resolved !== s) changed = true;
    return resolved;
  });
  return changed ? next : list;
}

// --- Store (this browser) ----------------------------------------------

let signals: ShadowSignal[] = load();
const listeners = new Set<() => void>();

function load(): ShadowSignal[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(signals));
  } catch {}
  listeners.forEach((l) => l());
}

export const shadowStore = {
  all(): ShadowSignal[] {
    return signals;
  },
  /** Adds new signals (one per setup per candle), keeping the newest MAX_KEPT. */
  add(fresh: ShadowSignal[]) {
    const next = mergeShadows(signals, fresh);
    if (next === signals) return;
    signals = next;
    save();
  },
  /** Resolves open signals against each coin's candles. */
  resolve(getBars: (symbol: string) => MarketBar[] | null, nowMs: number = Date.now()) {
    const next = resolveShadows(signals, getBars, nowMs);
    if (next === signals) return;
    signals = next;
    save();
  },
  /** Takes the server scanner's list as this browser's copy. */
  replaceAll(list: ShadowSignal[]) {
    signals = list.slice(0, MAX_KEPT);
    save();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** Test hook. */
  _reset(list: ShadowSignal[] = []) {
    signals = list;
  },
};
