import type { Position, TradeProposal } from "../types";
import type { RiskPolicyConfig } from "./riskEngine";
import { priceEntry } from "./entryPricing";
import { ruleFor } from "./marketRulesStore";
import { isBuiltOnSyntheticPrices } from "./dataProvenance";
import { openQuantity, planPartialQuantity } from "../shared/exitRules";
import { atrForExits, holdMinutesFor, trailsAsRunner } from "../shared/coinHolds";
import { MARKET_LABEL, marketOf, type MarketKey } from "../shared/marketLimits";

// Self-Approve (autopilot): which proposals it opens on its own. Shared by the
// app and the server scanner, so a trade is let through by the same rules
// wherever it's approved. A proposal is opened only while doing so keeps the
// book within the limits a human approver would be bound by: max positions,
// max exposure, one position per coin, a rolling-hour cap, and trader-panel
// agreement. Anything else is deferred with the reason, for a human to review.

const HOUR_MS = 60 * 60 * 1000;

export interface AutopilotAccepted {
  proposal: TradeProposal;
  entryPrice: number;
  units: number;
}

export interface AutopilotSelection {
  accepted: AutopilotAccepted[];
  deferred: { proposal: TradeProposal; reason: string }[];
}

export interface AutopilotBook {
  /** Open positions (quantity and price, for exposure and held coins). */
  positions: Pick<Position, "symbol" | "quantity" | "bankedQuantity" | "currentPrice">[];
  /** Positions autopilot opened in the last hour, open or closed. */
  openedLastHour: number;
  quarantines: Record<string, { quarantinedUntilMs: number }>;
}

/**
 * Autopilot openings in the hour before `now`: self-approved positions still
 * open plus self-approved trades already closed (a trade that stopped out
 * quickly still counts, or a losing streak could reopen without limit).
 */
export function autopilotOpeningsLastHour(
  positions: Pick<Position, "id" | "isSelfApproved" | "openTime">[],
  closed: { positionId?: string; isSelfApproved?: boolean; openedAt: string; openedAtMs?: number }[],
  now: number = Date.now(),
  extraIds: string[] = []
): number {
  const since = now - HOUR_MS;
  const ids = new Set<string>(extraIds);
  let anonymous = 0;
  for (const p of positions) {
    if (p.isSelfApproved && Date.parse(p.openTime) >= since) ids.add(p.id);
  }
  for (const t of closed) {
    if (!t.isSelfApproved) continue;
    // Closed trades show their open time as "HH:MM"; the ms one is what counts.
    const at = t.openedAtMs ?? Date.parse(t.openedAt);
    if (!Number.isFinite(at) || at < since) continue;
    if (t.positionId) ids.add(t.positionId);
    else anonymous++;
  }
  return ids.size + anonymous;
}

/**
 * Which of `proposals` autopilot opens, at what price and size, and why the
 * rest wait. Proposals are taken in order; each one accepted counts against
 * the limits for the next.
 */
export function selectAutopilotTrades(
  proposals: TradeProposal[],
  book: AutopilotBook,
  policy: RiskPolicyConfig,
  /** The price a new position would open at now: the ask for a long, the bid for a short, when known. */
  livePrice: (symbol: string, direction: "LONG" | "SHORT") => number | undefined,
  now: number = Date.now()
): AutopilotSelection {
  // From the book as it is now, not the snapshot each proposal was checked
  // against at scan time: several proposals from one scan could each pass
  // alone and together break the position or exposure limit.
  let positionCount = book.positions.length;
  const openByMarket: Record<MarketKey, number> = { coins: 0, stocks: 0 };
  for (const p of book.positions) openByMarket[marketOf(p.symbol)]++;
  let exposure = book.positions.reduce((acc, p) => acc + openQuantity(p) * p.currentPrice, 0);
  let hourly = book.openedLastHour;
  const held = new Set(book.positions.map((p) => p.symbol));

  const accepted: AutopilotAccepted[] = [];
  const deferred: AutopilotSelection["deferred"] = [];

  for (const proposal of proposals) {
    const units = proposal.riskCalc.recommendedPositionSizeUnits;
    if (units <= 0) {
      deferred.push({ proposal, reason: "Position size rounded to 0 after exchange lot-size snapping." });
      continue;
    }

    // Coins embargoed after a run of losses.
    const quarantine = book.quarantines[proposal.symbol];
    if (quarantine && quarantine.quarantinedUntilMs > now) {
      const mins = Math.ceil((quarantine.quarantinedUntilMs - now) / 60000);
      deferred.push({ proposal, reason: `Symbol is quarantined (${mins}m remaining) due to consecutive loss guard.` });
      continue;
    }

    // Swing setups hold for days with much wider stops: always a human's call.
    if (proposal.setup.horizon === "swing") {
      deferred.push({ proposal, reason: "Swing/long-horizon setup — always requires manual approval, regardless of consensus." });
      continue;
    }

    // Signals from generated price history say nothing about the real market.
    if (isBuiltOnSyntheticPrices(proposal)) {
      const pct = Math.round((proposal.dataQuality?.syntheticBarShare ?? 0) * 100);
      deferred.push({ proposal, reason: `Built on generated price history (${pct}% of bars) — manual review only.` });
      continue;
    }

    // Enter at the price it would really fill at (the ask for a long); skip
    // it if price has already run too far.
    const priced = priceEntry(proposal.setup, livePrice(proposal.symbol, proposal.setup.direction), units, proposal.riskCalc.riskDollars);
    if (!priced.ok) {
      deferred.push({ proposal, reason: priced.reason });
      continue;
    }
    const added = priced.units * priced.entryPrice;

    // Per market when set in Settings (amount per trade × trades at once bounds exposure then).
    const market = marketOf(proposal.symbol);
    const marketLimit = policy.marketLimits?.[market];
    const tooMany = marketLimit
      ? openByMarket[market] + 1 > marketLimit.maxOpenTrades
      : positionCount + 1 > policy.maxSimultaneousPositions;
    const tooExposed = !marketLimit && (exposure + added) / policy.equity > policy.maxAllowedExposureFraction;
    const alreadyHeld = held.has(proposal.symbol);
    const overHourly = hourly + 1 > policy.autopilotMaxApprovalsPerHour;
    // A split or thin panel vote is left for a human.
    const agreement = proposal.ensembleAgreement ?? 1;
    const votes = proposal.personaVotesCast ?? 1;
    const lacksConsensus = agreement < policy.autopilotMinConsensus || votes < policy.autopilotMinPersonaVotes;

    if (tooMany || tooExposed || alreadyHeld || overHourly || lacksConsensus) {
      const reasons: string[] = [];
      if (tooMany)
        reasons.push(
          marketLimit
            ? `would exceed ${marketLimit.maxOpenTrades} open ${MARKET_LABEL[market]} trade${marketLimit.maxOpenTrades === 1 ? "" : "s"} at once`
            : `would exceed max ${policy.maxSimultaneousPositions} simultaneous positions`
        );
      if (tooExposed) reasons.push(`would exceed max ${(policy.maxAllowedExposureFraction * 100).toFixed(0)}% portfolio exposure`);
      if (alreadyHeld) reasons.push(`already holding a ${proposal.symbol} position`);
      if (overHourly) reasons.push(`would exceed ${policy.autopilotMaxApprovalsPerHour} autonomous approvals/hour`);
      if (lacksConsensus)
        reasons.push(
          `panel consensus ${(agreement * 100).toFixed(0)}% with ${votes} vote(s) — needs ${(policy.autopilotMinConsensus * 100).toFixed(0)}%/${policy.autopilotMinPersonaVotes}`
        );
      deferred.push({ proposal, reason: reasons.join("; ") });
      continue;
    }

    accepted.push({ proposal, entryPrice: priced.entryPrice, units: priced.units });
    positionCount += 1;
    openByMarket[market] += 1;
    exposure += added;
    hourly += 1;
    held.add(proposal.symbol);
  }
  return { accepted, deferred };
}

/**
 * ATR recorded on a position for its trailing-stop rules. The indicator used
 * to be floored at 0.3% of price, and the exit rules were tuned with that
 * floor, so it's kept.
 */
export { atrForExits };

/** The position autopilot opens for an accepted proposal. */
export function positionFromProposal(
  { proposal, entryPrice, units }: AutopilotAccepted,
  opts: { id: string; atr: number; trailProfile: string; now?: number }
): Position {
  const { setup } = proposal;
  const runner = trailsAsRunner(setup);
  return {
    id: opts.id,
    symbol: proposal.symbol,
    direction: setup.direction,
    setupName: setup.name,
    entryPrice,
    currentPrice: entryPrice,
    quantity: units,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    initialTakeProfit: setup.takeProfit,
    initialStopLoss: setup.stopLoss,
    partialQuantity: planPartialQuantity(units, entryPrice, ruleFor(proposal.symbol, entryPrice)),
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    openTime: new Date(opts.now ?? Date.now()).toISOString(),
    expectedHoldingTimeMinutes: holdMinutesFor(setup),
    metaConfidence: proposal.metaScore.confidence,
    isSelfApproved: true,
    highestPrice: entryPrice,
    lowestPrice: entryPrice,
    trailActive: false,
    atrAtEntry: opts.atr,
    family: setup.family,
    horizon: setup.horizon,
    trailMode: runner ? "TREND_RUNNER" : "SCALP_TIGHT",
    trailProfile: opts.trailProfile,
  };
}

/** A position id that won't repeat. */
export function newPositionId(now: number = Date.now()): string {
  return `pos-${now}-${Math.random().toString(36).slice(2, 8)}`;
}
