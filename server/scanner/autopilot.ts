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
  /** Latest price for a symbol, if known. */
  livePrice: (symbol: string) => number | undefined;
  /** ATR of the latest closed candle. */
  barAtr: (symbol: string) => number | undefined;
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
  const mine = [...daemonPositions.values()].filter((p) => p.userId === uid);
  const recent = (openings.get(uid) ?? []).filter((o) => o.at >= now - HOUR_MS);
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
      quarantines: desk.quarantines,
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
  openings.set(uid, recent);

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

/** Test hook. */
export function _resetServerAutopilot(): void {
  openings.clear();
}
