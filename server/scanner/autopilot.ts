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
import { loadLiveRiskConfig } from "../liveOrderGuard";
import { placeLiveEntry } from "../liveEntry";
import { isNseSymbol } from "../../src/shared/nse";
import { isUsSymbol } from "../../src/shared/usMarket";
import { reviewTrade } from "../tradeReviewer";
import type { MarketBar } from "../../src/types";

// Self-Approve on the server: after each scan, the proposals autopilot would
// have opened in the app are opened here, by the same rules (the shared
// selectAutopilotTrades), so trades are taken while the app is closed. The
// position goes straight to the 24/7 guardian and the app picks it up when
// it's open.
//
// In Live mode it places real CoinDCX orders, but only while the server
// allows live orders at all (LIVE_TRADING_ENABLED=true), and each one goes
// through the same path and checks as one you approve (server/liveEntry.ts:
// exchange minimums, the server's per-order and daily caps, one order per
// position). Stocks wait for you in Live mode: Angel One orders aren't set
// up. The app's own autopilot never places live orders; this one does.

const HOUR_MS = 60 * 60 * 1000;

/** Positions each user's server autopilot opened in the last hour (ids), in case the app closed them since. */
const openings = new Map<string, { id: string; at: number }[]>();

export interface ServerAutopilotDeps {
  /** The price a new position would open at: the ask for a long, the bid for a short, when known. */
  livePrice: (symbol: string, direction: "LONG" | "SHORT") => number | undefined;
  /** ATR of the latest closed candle. */
  barAtr: (symbol: string) => number | undefined;
  /** Closed 5-minute candles, for Gemini's review. */
  bars?: (symbol: string) => MarketBar[] | undefined;
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

/** Whether the server's autopilot may open trades for this desk now (in Live mode, see liveAutopilotBlock too). */
export function serverAutopilotOn(desk: DeskState): boolean {
  return desk.autopilot && !desk.killSwitch && !desk.failureState.globalKillSwitchActive;
}

/** Why the server's autopilot can't place live orders now, or null if it can. */
export function liveAutopilotBlock(desk: DeskState): string | null {
  if ((desk.tradingMode ?? "PAPER") !== "LIVE_COINDCX") return null;
  if (!loadLiveRiskConfig().enabled) return "Live orders are blocked on the server (LIVE_TRADING_ENABLED isn't on), so live trades wait for you.";
  return null;
}

export interface ServerAutopilotHooks {
  /** Places a real entry order (server/liveEntry.ts); swapped in tests. */
  placeLiveEntry: typeof placeLiveEntry;
  /** Gemini's take-or-skip (server/tradeReviewer.ts); swapped in tests. */
  reviewTrade?: typeof reviewTrade;
}
const defaultHooks: ServerAutopilotHooks = { placeLiveEntry, reviewTrade };

/**
 * Opens the proposals autopilot accepts and marks every proposal with what
 * happened (APPROVED or DEFERRED, with the reason). Returns the proposals
 * as marked; unchanged if autopilot is off.
 */
export async function runServerAutopilot(
  uid: string,
  desk: DeskState,
  proposals: TradeProposal[],
  policy: RiskPolicyConfig,
  deps: ServerAutopilotDeps,
  now: number = Date.now(),
  hooks: ServerAutopilotHooks = defaultHooks
): Promise<TradeProposal[]> {
  if (!serverAutopilotOn(desk) || proposals.length === 0) return proposals;
  const live = (desk.tradingMode ?? "PAPER") === "LIVE_COINDCX";
  const blocked = liveAutopilotBlock(desk);
  if (blocked) return proposals.map((p) => ({ ...p, status: "DEFERRED" as const, deferralReason: blocked }));
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

  const liveRefused = new Map<string, string>();
  const reviews = new Map<string, NonNullable<TradeProposal["aiReview"]>>();
  const review = hooks.reviewTrade ?? reviewTrade;
  for (const a of accepted) {
    // Gemini's second opinion: it can skip a trade, never add one. Without
    // an answer the trade goes ahead on the checks above.
    const verdict = await review(a.proposal, deps.bars?.(a.proposal.symbol), now);
    if (!verdict.off) reviews.set(a.proposal.id, { outcome: verdict.outcome, reason: verdict.reason, model: verdict.model });
    if (verdict.outcome === "skip") {
      liveRefused.set(a.proposal.id, `Gemini skipped it: ${verdict.reason}`);
      console.log(`[ServerAutopilot] Gemini skipped ${a.proposal.symbol} for ${uid}: ${verdict.reason}`);
      continue;
    }
    const position = positionFromProposal(a, {
      id: newPositionId(now),
      atr: atrForExits(a.proposal.setup, deps.barAtr(a.proposal.symbol)),
      trailProfile: desk.trailProfile ?? DEFAULT_TRAIL_PROFILE,
      now,
    });
    if (live) {
      // Real money: coins only (Angel One orders aren't set up), buying only
      // (CoinDCX's INR markets are spot), and never banking half (that would
      // need a second real order).
      if (isNseSymbol(position.symbol)) {
        liveRefused.set(a.proposal.id, "Angel One live orders aren't set up yet, so live stock trades wait for you.");
        continue;
      }
      if (isUsSymbol(position.symbol)) {
        liveRefused.set(a.proposal.id, "US stocks are paper only for now, so live US trades wait for you.");
        continue;
      }
      if (position.direction !== "LONG") {
        liveRefused.set(a.proposal.id, "CoinDCX's INR markets can't be sold short.");
        continue;
      }
      const result = await hooks.placeLiveEntry({
        userId: uid,
        positionId: position.id,
        symbol: position.symbol,
        side: "buy",
        quantity: position.quantity,
        price: position.entryPrice,
      });
      if (!result.ok) {
        liveRefused.set(a.proposal.id, `CoinDCX order not placed: ${result.error}`);
        console.warn(`[ServerAutopilot] Live ${position.symbol} not placed for ${uid}: ${result.error}`);
        continue;
      }
      const filled = result.executedPrice && result.executedPrice > 0 ? result.executedPrice : position.entryPrice;
      Object.assign(position, {
        entryPrice: filled,
        currentPrice: filled,
        highestPrice: filled,
        lowestPrice: filled,
        quantity: result.quantity,
        partialQuantity: undefined,
      });
      openServerPosition(uid, position, { live: true });
    } else {
      openServerPosition(uid, position);
    }
    recent.push({ id: position.id, at: now });
    console.log(`[ServerAutopilot] Opened ${live ? "LIVE " : ""}${position.symbol} ${position.direction} x${position.quantity} @ ${position.entryPrice} for ${uid}`);
  }
  openings.set(uid, lastOpen && !recent.includes(lastOpen) ? [lastOpen, ...recent] : recent);

  const approved = new Set(accepted.filter((a) => !liveRefused.has(a.proposal.id)).map((a) => a.proposal.id));
  const reasons = new Map([...deferred.map((d) => [d.proposal.id, d.reason] as const), ...liveRefused]);
  return proposals.map((p) => {
    const reviewed = reviews.has(p.id) ? { ...p, aiReview: reviews.get(p.id) } : p;
    return approved.has(p.id)
      ? { ...reviewed, status: "APPROVED" as const }
      : reasons.has(p.id)
        ? { ...reviewed, status: "DEFERRED" as const, deferralReason: reasons.get(p.id) }
        : reviewed;
  });
}

/** When the server's autopilot last opened a position for this user (0 if not since the server started). */
export function lastServerOpenAt(uid: string): number {
  return Math.max(0, ...(openings.get(uid) ?? []).map((o) => o.at));
}

/** Test hook. */
export function _resetServerAutopilot(): void {
  openings.clear();
}
