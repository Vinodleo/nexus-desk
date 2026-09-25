import type { HistoricalTrade, Position } from "../types";

// What happened while the phone was locked, for the notice shown on unlock.
// How loud the notice is depends on what happened:
//   - away briefly and nothing changed: only the header badge glows;
//   - away longer and nothing changed: a small "Back online" pill;
//   - anything opened or closed meanwhile: the "While you were away" card.

/** Shorter locks than this, with nothing traded, only get the badge glow. */
export const QUIET_AWAY_MS = 30_000;
/** How long to wait after unlocking for the server's catch-up (closes and opens made while locked) before summing up. */
export const AWAY_SETTLE_MS = 3_000;

export interface AwaySummary {
  awayMs: number;
  opened: { id: string; symbol: string; byServer: boolean }[];
  closed: { id: string; symbol: string; pnl: number; exitReason: HistoricalTrade["exitReason"] }[];
  /** Net result of the trades that closed while away. */
  netPnl: number;
}

export type AwayTier = "glow" | "pill" | "card";

const at = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/** Opens and closes stamped between `since` and `now`. A trade both opened and closed meanwhile shows under closed. */
export function summarizeAway(
  since: number,
  now: number,
  positions: Pick<Position, "id" | "symbol" | "openTime" | "openedByServer">[],
  closedTrades: Pick<HistoricalTrade, "id" | "positionId" | "symbol" | "realizedPnl" | "exitReason" | "openedAt" | "closedAt" | "openedByServer">[]
): AwaySummary {
  const within = (t: number) => t >= since && t <= now;
  const closed = closedTrades
    .filter((t) => within(at(t.closedAt)))
    .map((t) => ({ id: t.positionId ?? t.id, symbol: t.symbol, pnl: t.realizedPnl, exitReason: t.exitReason }));
  const opened = positions
    .filter((p) => within(at(p.openTime)))
    .map((p) => ({ id: p.id, symbol: p.symbol, byServer: Boolean(p.openedByServer) }));
  const netPnl = Number(closed.reduce((s, t) => s + (Number.isFinite(t.pnl) ? t.pnl : 0), 0).toFixed(2));
  return { awayMs: Math.max(0, now - since), opened, closed, netPnl };
}

export function awayTier(s: AwaySummary): AwayTier {
  if (s.opened.length > 0 || s.closed.length > 0) return "card";
  return s.awayMs < QUIET_AWAY_MS ? "glow" : "pill";
}

/** "42 s", "5 min 24 s", "1 h 12 min". */
export function formatAway(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
