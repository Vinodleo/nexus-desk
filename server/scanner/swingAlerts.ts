import type { TradeProposal } from "../../src/types";
import { notifyUser, swingWaitingMessage } from "../push";

// A pop-up when a swing setup is waiting for you. The autopilot never opens
// swing trades (they hold for days with a wide stop, and the traders'
// records don't cover them), and a proposal waits only about ten minutes, so
// without one it would usually expire unseen. A setup on the same market and
// side keeps turning up on each candle while it holds, so it's announced
// once an hour at most.

/** The same market and side is announced again only after this long. */
export const SWING_ALERT_GAP_MS = 60 * 60 * 1000;

const lastAnnounced = new Map<string, number>();

/** This scan's swing proposals left waiting for you that haven't been announced lately. */
export function swingsToAnnounce(uid: string, proposals: TradeProposal[], now: number = Date.now()): TradeProposal[] {
  const out: TradeProposal[] = [];
  for (const p of proposals) {
    if (p.setup?.horizon !== "swing") continue;
    if (p.status !== "PENDING_APPROVAL" && p.status !== "DEFERRED") continue;
    const key = `${uid}|${p.symbol}|${p.setup.direction}`;
    const last = lastAnnounced.get(key);
    if (last !== undefined && now - last < SWING_ALERT_GAP_MS) continue;
    lastAnnounced.set(key, now);
    out.push(p);
  }
  return out;
}

/** Sends the pop-ups; never throws. */
export function announceSwings(uid: string, proposals: TradeProposal[], now: number = Date.now()): void {
  for (const p of swingsToAnnounce(uid, proposals, now)) {
    void notifyUser(uid, swingWaitingMessage(p, now)).catch((err) => console.warn("[SwingAlerts] Couldn't notify:", err?.message ?? err));
  }
}

/** Test hook. */
export function _resetSwingAlerts(): void {
  lastAnnounced.clear();
}
