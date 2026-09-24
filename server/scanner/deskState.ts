import fs from "fs";
import path from "path";
import type { FailureInjectionState, PromotedLabModel, TradingExecutionMode } from "../../src/types";

// What the server scanner needs to scan for a user the way the app would:
// their equity and limits, today's P&L, the kill switch and drills, coin
// quarantines and the promoted Lab settings. The app sends it whenever it
// changes; it's kept on disk so scanning carries on after a restart.

export interface DeskState {
  equity: number;
  riskLimits: { maxOrderValueInr: number; maxAllowedExposureFraction: number };
  dailyRealizedPnl: number;
  /** Day (IST, YYYY-MM-DD) dailyRealizedPnl belongs to; it counts as 0 on a later day. */
  pnlDay: string;
  autopilot: boolean;
  /** Paper or live. The server's autopilot opens paper trades only. */
  tradingMode?: TradingExecutionMode;
  /** Trailing-stop profile new positions carry (shared/trailingStop). */
  trailProfile?: string;
  killSwitch: boolean;
  /** Continuous scanning switched on in the app. */
  scanning: boolean;
  failureState: FailureInjectionState;
  quarantines: Record<string, { quarantinedUntilMs: number }>;
  promotedModel: PromotedLabModel | null;
  updatedAt: number;
}

const DATA_DIR = process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "desk_state.json");

const desks = new Map<string, DeskState>();

export function istDay(ms: number = Date.now()): string {
  return new Date(ms + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function loadDeskStates(): void {
  try {
    if (!fs.existsSync(FILE)) return;
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    for (const [uid, desk] of Object.entries(saved ?? {})) desks.set(uid, desk as DeskState);
  } catch (err) {
    console.warn("[Desk] Couldn't read saved desk state:", err);
  }
}

function save(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(Object.fromEntries(desks)), "utf8");
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (err) {
    console.warn("[Desk] Couldn't save desk state:", err);
  }
}

export function setDeskState(uid: string, state: Omit<DeskState, "updatedAt" | "pnlDay">, now: number = Date.now()): DeskState {
  const desk: DeskState = { ...state, pnlDay: istDay(now), updatedAt: now };
  desks.set(uid, desk);
  save();
  return desk;
}

export function getDeskState(uid: string): DeskState | undefined {
  return desks.get(uid);
}

/** Users the scanner should scan for: scanning on and heard from in the last week. */
export function scanningDesks(now: number = Date.now()): [string, DeskState][] {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  return [...desks.entries()].filter(([, d]) => d.scanning && now - d.updatedAt < WEEK);
}

/** Today's realised P&L: what the app last sent, or 0 once the day has changed. */
export function dailyPnlToday(desk: DeskState, now: number = Date.now()): number {
  return desk.pnlDay === istDay(now) ? desk.dailyRealizedPnl : 0;
}

/** Test hook. */
export function _resetDeskStates(): void {
  desks.clear();
}
