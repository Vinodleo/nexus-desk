import type { Position } from "../types";
import { bankPartial, blendedExitPrice, partialDue } from "../shared/exitRules";
import { exitAt, updateTrailingStop, type TrailExitReason } from "../shared/trailingStop";

// The browser book's per-tick position logic: price-sanity guard, trailing
// stop / profit lock (scalp and trend-runner modes, long and short), and
// stop / target exit detection. Pure: it returns an updated copy and never
// mutates the position it's given. (It used to run inline in App's WebSocket
// handler, mutating React state in place.)

export type TickExitReason = TrailExitReason;

export type TickOutcome =
  | { kind: "unchanged"; position: Position }
  | { kind: "rejected"; position: Position }
  /** `banked` is set on the tick that closed half the position at +1R. */
  | { kind: "updated"; position: Position; changed: boolean; banked?: boolean }
  | { kind: "exit"; position: Position; reason: TickExitReason; price: number };

/** INR per USDT, used only if a pair's INR price is missing but its USDT price arrives. */
export const USDT_INR_FALLBACK_RATE = 83.5;

/** A single tick implying a bigger move than this is held until a second tick confirms it. */
export const SUSPECT_TICK_DEVIATION = 0.25;

/** Price for a position's symbol from a batch of ticks, falling back to the USDT pair. */
export function priceForPosition(pos: Pick<Position, "symbol">, prices: Record<string, number>): number | undefined {
  const inr = prices[pos.symbol];
  if (inr) return inr;
  const usdt = prices[`${pos.symbol.split("/")[0]}/USDT`];
  return usdt ? usdt * USDT_INR_FALLBACK_RATE : undefined;
}

/** A rejected "implausible" price awaiting confirmation, and which tick batch saw it. */
export interface SuspectTick {
  price: number;
  tickSeq: number;
}

/**
 * @param pendingSuspect position id -> last rejected implausible price,
 *   shared across ticks so a later agreeing tick can confirm the move.
 * @param tickSeq id of the tick batch being applied. Only a *different*
 *   batch can confirm a suspect price, so re-applying the same batch (React
 *   runs state updaters twice in development) can't confirm itself.
 */
export function applyTickToPosition(
  original: Position,
  price: number | undefined,
  pendingSuspect: Map<string, SuspectTick>,
  tickSeq: number
): TickOutcome {
  if (!price) return { kind: "unchanged", position: original };

  // Price sanity guard: a real market essentially never moves >25% between
  // consecutive ticks, so such a tick is most likely bad data. Hold it until
  // a second tick lands within 3% of it; act on nothing until then.
  const referencePrice = original.currentPrice || original.entryPrice;
  const tickDeviation = referencePrice > 0 ? Math.abs(price - referencePrice) / referencePrice : 0;
  if (tickDeviation > SUSPECT_TICK_DEVIATION) {
    const pending = pendingSuspect.get(original.id);
    const confirmsPending =
      pending !== undefined && pending.tickSeq !== tickSeq && Math.abs(price - pending.price) / pending.price < 0.03;
    if (confirmsPending) {
      console.log(
        `[PriceGuard] Confirmed recovery for ${original.symbol}: ${referencePrice} -> ${price} (two consecutive ticks agreed). Accepting.`
      );
      pendingSuspect.delete(original.id);
    } else {
      console.warn(
        `[PriceGuard] Rejected implausible tick for ${original.symbol}: ${referencePrice} -> ${price} (${(tickDeviation * 100).toFixed(0)}% single-tick move). Awaiting confirmation. Position left unchanged.`
      );
      pendingSuspect.set(original.id, { price, tickSeq });
      return { kind: "rejected", position: original };
    }
  } else if (pendingSuspect.has(original.id)) {
    // Back within normal range on its own: drop what we were waiting to confirm.
    pendingSuspect.delete(original.id);
  }

  const pos: Position = { ...original };
  const isLong = pos.direction === "LONG";
  let changed = false;
  let exitReason: TickExitReason | null = null;

  // First reach of +1R on a paper position: bank half, stop past break-even.
  const banked = partialDue(pos, price);
  if (banked) {
    Object.assign(pos, bankPartial(pos, price));
    changed = true;
  }

  // Trailing stop and, for runners past the first target, the extended
  // target: the same rules the server guardian applies (shared/trailingStop).
  if (updateTrailingStop(pos, price)) changed = true;
  exitReason = exitAt(pos, price);

  if (exitReason) {
    return { kind: "exit", position: pos, reason: exitReason, price };
  }

  const pnl = (blendedExitPrice(pos, price) - pos.entryPrice) * pos.quantity * (isLong ? 1 : -1);
  const moneyPlaced = pos.entryPrice * pos.quantity;
  if (Math.abs(price - pos.currentPrice) > 0.0001) changed = true;
  // Trailing state must persist even on a tick that moves nothing else.
  // (The old inline code kept it by mutating state in place.)
  if (
    pos.highestPrice !== original.highestPrice ||
    pos.lowestPrice !== original.lowestPrice ||
    pos.trailActive !== original.trailActive
  ) {
    changed = true;
  }

  return {
    kind: "updated",
    position: { ...pos, currentPrice: price, unrealizedPnl: pnl, unrealizedPnlPercent: (pnl / moneyPlaced) * 100 },
    changed,
    ...(banked ? { banked: true } : {}),
  };
}
