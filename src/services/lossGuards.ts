// What happens after a trade closes, wherever it closed (in the app or by
// the server guardian):
// - A coin that just lost is left alone for 2 hours; after a win, for one
//   5-minute candle, so a trade isn't reopened straight away.
// - Three losses in a row stop autopilot until you've looked (the app trips
//   the kill switch; the server pauses its autopilot).
// Shared by the app and the server so both apply the same rules.

export const LOSS_COOLDOWN_MS = 120 * 60 * 1000;
export const WIN_COOLDOWN_MS = 5 * 60 * 1000;
export const LOSS_STREAK_LIMIT = 3;

export interface CloseRecord {
  symbol: string;
  isWin: boolean;
  closedAtMs?: number;
}

/** Until when a coin is left alone after this close. */
export function cooldownUntil(close: Pick<CloseRecord, "isWin" | "closedAtMs">, fallbackNow: number = Date.now()): number {
  return (close.closedAtMs ?? fallbackNow) + (close.isWin ? WIN_COOLDOWN_MS : LOSS_COOLDOWN_MS);
}

/** Coins still cooling down at `now`, from each coin's latest close. */
export function cooldownsFromCloses(closes: CloseRecord[], now: number = Date.now()): Record<string, { quarantinedUntilMs: number }> {
  const out: Record<string, { quarantinedUntilMs: number }> = {};
  for (const c of closes) {
    if (c.closedAtMs === undefined) continue;
    const until = cooldownUntil(c);
    if (until > now && until > (out[c.symbol]?.quarantinedUntilMs ?? 0)) out[c.symbol] = { quarantinedUntilMs: until };
  }
  return out;
}

/** Both sets of coin cooldowns, keeping the later end for a coin in both. */
export function mergeQuarantines(
  a: Record<string, { quarantinedUntilMs: number }>,
  b: Record<string, { quarantinedUntilMs: number }>
): Record<string, { quarantinedUntilMs: number }> {
  const out = { ...a };
  for (const [sym, q] of Object.entries(b)) {
    if (q.quarantinedUntilMs > (out[sym]?.quarantinedUntilMs ?? 0)) out[sym] = { quarantinedUntilMs: q.quarantinedUntilMs };
  }
  return out;
}

/**
 * Losses in a row at the start of `closes` (newest first), counting only
 * trades closed after `sinceMs` (when the kill switch was last turned off,
 * so a fresh start isn't stopped by the losses before it).
 */
export function lossStreak(closes: Pick<CloseRecord, "isWin" | "closedAtMs">[], sinceMs: number = 0): number {
  let n = 0;
  for (const c of closes) {
    if ((c.closedAtMs ?? 0) <= sinceMs || c.isWin) break;
    n++;
  }
  return n;
}
