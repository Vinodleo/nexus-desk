import type { Position, TradeProposal } from "../types";
import type { RiskPolicyConfig } from "./riskEngine";
import { priceEntry } from "./entryPricing";
import { ruleFor } from "./marketRulesStore";
import { isBuiltOnSyntheticPrices } from "./dataProvenance";
import { openQuantity, planPartialQuantity } from "../shared/exitRules";
import { atrForExits, holdMinutesFor, trailsAsRunner } from "../shared/coinHolds";
import { MARKET_LABEL, marketOf, sectorOf, slotKindOf, slotsFor, slotTradesLabel, slowStrategyOf, type MarketKey, type SlotKind } from "../shared/marketLimits";

// Self-Approve (autopilot): which proposals it opens on its own. Shared by the
// app and the server scanner, so a trade is let through by the same rules
// wherever it's approved. A proposal is opened only while doing so keeps the
// book within the limits a human approver would be bound by: max positions,
// max exposure, a few per stock sector, one position per coin, a rolling-hour
// cap, and trader-panel agreement. Anything else is deferred with the reason,
// for a human to review.

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
  positions: Pick<Position, "symbol" | "quantity" | "bankedQuantity" | "currentPrice" | "strategy">[];
  /** Positions autopilot opened in the last hour, open or closed. */
  openedLastHour: number;
  quarantines: Record<string, { quarantinedUntilMs: number }>;
  /** A paper desk's money free to trade (shared/paperCash): a trade that costs more waits. Absent on a live desk. */
  freeCash?: number;
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
  // Per market, on each kind's own slots: breakout 55/20's, momentum's, and the rest's.
  const slotsByKind = new Map<SlotKind, Record<MarketKey, number>>();
  const slotsOf = (kind: SlotKind) => {
    if (!slotsByKind.has(kind)) slotsByKind.set(kind, { coins: 0, stocks: 0, us: 0 });
    return slotsByKind.get(kind)!;
  };
  for (const p of book.positions) slotsOf(slotKindOf(p))[marketOf(p.symbol)]++;
  const openBySector = new Map<string, number>();
  for (const p of book.positions) {
    const key = sectorOf(p.symbol)?.key;
    if (key) openBySector.set(key, (openBySector.get(key) ?? 0) + 1);
  }
  let exposure = book.positions.reduce((acc, p) => acc + openQuantity(p) * p.currentPrice, 0);
  let hourly = book.openedLastHour;
  let cashLeft = book.freeCash;
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
    const kind = slotKindOf(proposal.setup);
    const slots = slotsOf(kind);
    const tooMany = marketLimit
      ? slots[market] + 1 > slotsFor(marketLimit, kind)
      : positionCount + 1 > policy.maxSimultaneousPositions;
    const tooExposed = !marketLimit && (exposure + added) / policy.equity > policy.maxAllowedExposureFraction;
    const sector = sectorOf(proposal.symbol);
    const sectorFull = !!sector && (openBySector.get(sector.key) ?? 0) + 1 > policy.maxCorrelatedPositionsPerGroup;
    const alreadyHeld = held.has(proposal.symbol);
    // The hourly cap stops a burst of 5-minute trades. Breakout's and
    // momentum's checks open their picks together once a day or week, on
    // slots of their own that bound them, so it doesn't hold them back (a
    // momentum pick turned away would wait a week); they still count toward it.
    const overHourly = !kind && hourly + 1 > policy.autopilotMaxApprovalsPerHour;
    // A split or thin panel vote is left for a human.
    const agreement = proposal.ensembleAgreement ?? 1;
    const votes = proposal.personaVotesCast ?? 1;
    const lacksConsensus = agreement < policy.autopilotMinConsensus || votes < policy.autopilotMinPersonaVotes;
    // A paper desk can't spend money it doesn't have.
    const shortOfCash = cashLeft !== undefined && added > cashLeft + 0.01;

    if (tooMany || tooExposed || sectorFull || alreadyHeld || overHourly || lacksConsensus || shortOfCash) {
      const reasons: string[] = [];
      if (tooMany)
        reasons.push(
          marketLimit
            ? `would exceed ${slotsFor(marketLimit, kind)} open ${slotTradesLabel(market, kind)} trade${slotsFor(marketLimit, kind) === 1 ? "" : "s"} at once`
            : `would exceed max ${policy.maxSimultaneousPositions} simultaneous positions`
        );
      if (tooExposed) reasons.push(`would exceed max ${(policy.maxAllowedExposureFraction * 100).toFixed(0)}% portfolio exposure`);
      if (sectorFull) reasons.push(`would exceed ${policy.maxCorrelatedPositionsPerGroup} open trades in ${sector!.label}`);
      if (alreadyHeld) reasons.push(`already holding a ${proposal.symbol} position`);
      if (overHourly) reasons.push(`would exceed ${policy.autopilotMaxApprovalsPerHour} autonomous approvals/hour`);
      if (shortOfCash) reasons.push(`not enough free cash: ₹${Math.round(cashLeft!).toLocaleString("en-IN")} left for a ₹${Math.round(added).toLocaleString("en-IN")} trade`);
      if (lacksConsensus)
        reasons.push(
          `panel consensus ${(agreement * 100).toFixed(0)}% with ${votes} vote(s) — needs ${(policy.autopilotMinConsensus * 100).toFixed(0)}%/${policy.autopilotMinPersonaVotes}`
        );
      deferred.push({ proposal, reason: reasons.join("; ") });
      continue;
    }

    accepted.push({ proposal, entryPrice: priced.entryPrice, units: priced.units });
    positionCount += 1;
    slots[market] += 1;
    if (sector) openBySector.set(sector.key, (openBySector.get(sector.key) ?? 0) + 1);
    exposure += added;
    if (cashLeft !== undefined) cashLeft -= added;
    hourly += 1;
    held.add(proposal.symbol);
  }
  return { accepted, deferred };
}

/** Why autopilot leaves a proposal the app's own scan found. */
export const PHONE_SCAN_HOLD_REASON =
  "Found by this phone while the server wasn't scanning. Autopilot opens only trades that pass the server's checks (each trader judged on every market, spreads included), so this one waits for you.";

/**
 * The queue's waiting proposals, split into those autopilot may open and
 * those it leaves for you: ones the app's own scan found. The app judges
 * traders on its coins alone, without the spread or their record in the
 * other markets, so it can pass a trader the server has paused. Only
 * proposals the server's checks passed are opened on their own.
 */
export function autopilotQueue(queue: TradeProposal[]): { take: TradeProposal[]; hold: TradeProposal[] } {
  const waiting = queue.filter((p) => p.status === "PENDING_APPROVAL");
  return { take: waiting.filter((p) => !p.scannedOnPhone), hold: waiting.filter((p) => p.scannedOnPhone) };
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
  // A slower strategy's trade (breakout's, the funds' included, or momentum's): it keeps its strategy's name.
  const slow = slowStrategyOf(setup.strategy);
  return {
    id: opts.id,
    symbol: proposal.symbol,
    direction: setup.direction,
    setupName: setup.name,
    entryPrice,
    signalPrice: setup.entryPrice,
    currentPrice: entryPrice,
    quantity: units,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    initialTakeProfit: setup.takeProfit,
    initialStopLoss: setup.stopLoss,
    // A breakout or momentum trade isn't banked early: it runs whole until its exit, as replayed.
    partialQuantity: slow ? undefined : planPartialQuantity(units, entryPrice, ruleFor(proposal.symbol, entryPrice)),
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
    // A breakout or momentum trade keeps its first stop (it's sold by its own rule instead of trailing).
    trailProfile: slow ? "fixed" : opts.trailProfile,
    // A daily-candle trade: held up to 30 days (holdMinutesFor), closed at that limit exactly.
    ...(setup.timeframe === "1d" ? { timeframe: "1d" as const } : {}),
    ...(slow ? { strategy: slow } : {}),
  };
}

/** A position id that won't repeat. */
export function newPositionId(now: number = Date.now()): string {
  return `pos-${now}-${Math.random().toString(36).slice(2, 8)}`;
}
