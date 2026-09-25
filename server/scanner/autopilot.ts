import type { TradeProposal } from "../../src/types";
import type { RiskPolicyConfig } from "../../src/services/riskEngine";
import {
  atrForExits,
  autopilotOpeningsLastHour,
  newPositionId,
  positionFromProposal,
  selectAutopilotTrades,
} from "../../src/services/autopilot";
import { DEFAULT_TRAIL_PROFILE } from "../../src/shared/trailingStop";
import { LOSS_STREAK_LIMIT, cooldownsFromCloses, lossStreak, mergeQuarantines } from "../../src/services/lossGuards";
import { closedTradesFor, daemonPositions, openServerPosition } from "../guardian";
import type { DeskState } from "./deskState";

// Self-Approve on the server: after each scan, the proposals autopilot would
// have opened in the app are opened here, by the same rules (the shared
// selectAutopilotTrades), so trades are taken while the app is closed. The
// position goes straight to the 24/7 guardian and the app picks it up when
// it's open. Paper trading only: a live order needs the app.

const HOUR_MS = 60 * 60 * 1000;

/** Positions each user's server autopilot opened in the last hour (ids), in case the app closed them since. */
const openings = new Map<string, { id: string; at: number }[]>();

export interface ServerAutopilotDeps {
  /** The price a new position would open at: the ask for a long, the bid for a short, when known. */
  livePrice: (symbol: string, direction: "LONG" | "SHORT") => number | undefined;
  /** ATR of the latest closed candle. */
  barAtr: (symbol: string) => number | undefined;
}

/** This user's guardian closes, newest first, for the loss guards. */
function serverCloses(uid: string) {
  return closedTradesFor(uid).map((t) => ({ symbol: t.symbol, isWin: t.isWin, closedAtMs: Date.parse(t.closedAt) }));
}

/**
 * Coins to leave alone: the app's cooldowns plus those from trades the
 * guardian closed (the app hears of those only when it's open).
 */
export function serverQuarantines(uid: string, desk: DeskState, now: number = Date.now()): Record<string, { quarantinedUntilMs: number }> {
  return mergeQuarantines(desk.quarantines, cooldownsFromCloses(serverCloses(uid), now));
}

/**
 * Losses in a row: the guardian's closes since the app last sent its desk
 * settings, continuing the app's own count if every one of them lost.
 */
export function serverLossStreak(uid: string, desk: DeskState): number {
  const since = serverCloses(uid).filter((c) => c.closedAtMs > desk.updatedAt);
  const streak = lossStreak(since, desk.updatedAt);
  return streak === since.length ? streak + (desk.lossStreak ?? 0) : streak;
}

/** Whether the server's autopilot may open trades for this desk now. */
export function serverAutopilotOn(desk: DeskState): boolean {
  return desk.autopilot && !desk.killSwitch && !desk.failureState.globalKillSwitchActive && (desk.tradingMode ?? "PAPER") === "PAPER";
}

/**
 * Opens the proposals autopilot accepts and marks every proposal with what
 * happened (APPROVED or DEFERRED, with the reason). Returns the proposals
 * as marked; unchanged if autopilot is off.
 */
export function runServerAutopilot(
  uid: string,
  desk: DeskState,
  proposals: TradeProposal[],
  policy: RiskPolicyConfig,
  deps: ServerAutopilotDeps,
  now: number = Date.now()
): TradeProposal[] {
  if (!serverAutopilotOn(desk) || proposals.length === 0) return proposals;
  // Three losses in a row: stop until you've looked (the app trips its kill
  // switch when it hears of them; turning it off starts a fresh count).
  if (serverLossStreak(uid, desk) >= LOSS_STREAK_LIMIT) {
    const reason = `${LOSS_STREAK_LIMIT} losses in a row — autopilot is paused until you review them in the app.`;
    return proposals.map((p) => ({ ...p, status: "DEFERRED" as const, deferralReason: reason }));
  }
  const mine = [...daemonPositions.values()].filter((p) => p.userId === uid);
  const logged = openings.get(uid) ?? [];
  // The hour's openings count toward the cap; the last one is kept for the status.
  const recent = logged.filter((o) => o.at >= now - HOUR_MS);
  const lastOpen = logged.reduce<{ id: string; at: number } | null>((a, o) => (!a || o.at > a.at ? o : a), null);
  const { accepted, deferred } = selectAutopilotTrades(
    proposals,
    {
      positions: mine.map((p) => ({ ...p, currentPrice: p.currentPrice || p.entryPrice })),
      openedLastHour: autopilotOpeningsLastHour(
        mine.map((p) => ({ id: p.id, isSelfApproved: p.isSelfApproved, openTime: p.openTime })),
        closedTradesFor(uid),
        now,
        recent.map((o) => o.id)
      ),
      quarantines: serverQuarantines(uid, desk, now),
    },
    policy,
    deps.livePrice,
    now
  );

  for (const a of accepted) {
    const position = positionFromProposal(a, {
      id: newPositionId(now),
      atr: atrForExits(deps.barAtr(a.proposal.symbol), a.proposal.setup.entryPrice),
      trailProfile: desk.trailProfile ?? DEFAULT_TRAIL_PROFILE,
      now,
    });
    openServerPosition(uid, position);
    recent.push({ id: position.id, at: now });
    console.log(`[ServerAutopilot] Opened ${position.symbol} ${position.direction} x${position.quantity} @ ${position.entryPrice} for ${uid}`);
  }
  openings.set(uid, lastOpen && !recent.includes(lastOpen) ? [lastOpen, ...recent] : recent);

  const approved = new Set(accepted.map((a) => a.proposal.id));
  const reasons = new Map(deferred.map((d) => [d.proposal.id, d.reason]));
  return proposals.map((p) =>
    approved.has(p.id)
      ? { ...p, status: "APPROVED" as const }
      : reasons.has(p.id)
        ? { ...p, status: "DEFERRED" as const, deferralReason: reasons.get(p.id) }
        : p
  );
}

/** When the server's autopilot last opened a position for this user (0 if not since the server started). */
export function lastServerOpenAt(uid: string): number {
  return Math.max(0, ...(openings.get(uid) ?? []).map((o) => o.at));
}

/** Test hook. */
export function _resetServerAutopilot(): void {
  openings.clear();
}
