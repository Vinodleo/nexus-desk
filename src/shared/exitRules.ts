// Exit rules shared by the browser book and the server guardian, so a
// position is handled the same way whichever side sees the price first.
//
// - Banking half at +1R: when a paper position first gains as much as it
//   risked, half of it is closed and the stop moves past break-even after
//   costs (or to entry, when the price isn't past that yet), so the rest runs
//   for free. Live CoinDCX positions don't do this (it would need a real
//   exchange order).
// - The time limit cuts trades that haven't worked, not winners: past its
//   limit a position whose stop already locks in profit keeps running on that
//   stop, up to HOLD_EXTENSION_MULTIPLE times the limit. Daily-candle trades
//   close at their limit exactly, as the two-year replay they're judged on
//   closed them.

import { isUsSymbol, usSquareOffDue, US_BREAKEVEN_BUFFER } from "./usMarket";
import { floorToStep, type MarketRule } from "./marketRules";
import { isNseSymbol, nseSquareOffDue } from "./nse";
import { COIN_ROUND_TRIP_FEE, roundTripFeeRate } from "./tradeCosts";

/** Gain, in multiples of the initial risk, at which half the position is banked. */
export const PARTIAL_AT_R = 1;
/** A typical coin spread, on top of the fees, in what a "locked" coin stop must clear. */
export const COIN_SPREAD_ALLOWANCE = 0.0008;
/** Coins: CoinDCX's fees both ways (1.18%) plus a typical spread, the least a "locked" stop must be past entry. */
export const BREAKEVEN_BUFFER = Number((COIN_ROUND_TRIP_FEE + COIN_SPREAD_ALLOWANCE).toFixed(6));
/** The same for Indian stocks, whose costs are higher (brokerage per order, STT, GST). */
export const NSE_BREAKEVEN_BUFFER = 0.003;

/** The least a "locked" stop must be past entry for this symbol. */
export function breakevenBuffer(symbol?: string): number {
  if (isUsSymbol(symbol)) return US_BREAKEVEN_BUFFER;
  if (isNseSymbol(symbol)) return NSE_BREAKEVEN_BUFFER;
  // The coin round trip in use (tests of 5-minute coin setups charge a cheaper one).
  return Number((roundTripFeeRate("BTC/INR") + COIN_SPREAD_ALLOWANCE).toFixed(6));
}
/** A winner may run to this many times its time limit before it's closed regardless. */
export const HOLD_EXTENSION_MULTIPLE = 3;
export const DEFAULT_HOLD_MINUTES = 30;

export interface ExitState {
  /** Decides the market's rules: NSE stocks close by 3:20 IST and cost more to trade. */
  symbol?: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  openTime: string;
  expectedHoldingTimeMinutes?: number;
  /** The stop when the position opened; the 1R distance is measured from it. */
  initialStopLoss?: number;
  /** How much to bank at +1R, fitted to the exchange's quantity step when opened. */
  partialQuantity?: number;
  /** How much was banked, and at what price, once it has been. */
  bankedQuantity?: number;
  bankedPrice?: number;
  isLiveOrder?: boolean;
  /** "1d": opened on daily candles (shared/coinHolds DAILY_HOLD_MINUTES). */
  timeframe?: string;
  /** "breakout" or "momentum": a slower strategy's, held for weeks (overnight too) until its own exit. */
  strategy?: string;
}

/** Rupees a position had at stake when it opened: 1R. Undefined without its first stop. */
export function riskAtOpen(p: Pick<ExitState, "entryPrice" | "initialStopLoss" | "quantity">): number | undefined {
  if (p.initialStopLoss === undefined) return undefined;
  const risk = Math.abs(p.entryPrice - p.initialStopLoss) * p.quantity;
  return risk > 0 ? Number(risk.toFixed(2)) : undefined;
}

/** Quantity still open. */
export function openQuantity(p: Pick<ExitState, "quantity" | "bankedQuantity">): number {
  return Math.max(0, p.quantity - (p.bankedQuantity ?? 0));
}

/** The stop already guarantees a profit after fees. */
export function stopLocksProfit(p: Pick<ExitState, "symbol" | "direction" | "entryPrice" | "stopLoss">): boolean {
  const buffer = breakevenBuffer(p.symbol);
  return p.direction === "LONG"
    ? p.stopLoss >= p.entryPrice * (1 + buffer) - 1e-9
    : p.stopLoss <= p.entryPrice * (1 - buffer) + 1e-9;
}

/**
 * At or past the time limit: close a position that hasn't locked in profit;
 * let one that has keep running, up to the extended limit.
 */
export function holdingDecision(p: ExitState, nowMs: number = Date.now()): "hold" | "expire" {
  // Stock positions are intraday: closed at 3:20 IST (US: 3:50 New York) whatever else holds,
  // except breakout and momentum trades, held overnight until their own exit.
  const intraday = p.strategy !== "breakout" && p.strategy !== "momentum";
  if (intraday && isNseSymbol(p.symbol) && nseSquareOffDue(p.openTime, nowMs)) return "expire";
  if (intraday && isUsSymbol(p.symbol) && usSquareOffDue(p.openTime, nowMs)) return "expire";
  const openedMs = p.openTime ? new Date(p.openTime).getTime() : nowMs;
  const elapsed = (nowMs - openedMs) / 60000;
  const limit = p.expectedHoldingTimeMinutes || DEFAULT_HOLD_MINUTES;
  if (elapsed < limit) return "hold";
  if (p.timeframe === "1d" || elapsed >= limit * HOLD_EXTENSION_MULTIPLE) return "expire";
  return stopLocksProfit(p) ? "hold" : "expire";
}

/** Whether this price banks half the position now. */
export function partialDue(p: ExitState, price: number): boolean {
  if (p.isLiveOrder || (p.bankedQuantity ?? 0) > 0) return false;
  const part = p.partialQuantity ?? 0;
  if (!(part > 0) || part >= p.quantity || p.initialStopLoss === undefined) return false;
  const risk = Math.abs(p.entryPrice - p.initialStopLoss);
  if (!(risk > 0)) return false;
  return p.direction === "LONG" ? price >= p.entryPrice + risk * PARTIAL_AT_R : price <= p.entryPrice - risk * PARTIAL_AT_R;
}

/**
 * The fields that change when half is banked at `price`: the banked part,
 * and a stop past break-even after costs, or at entry when the price isn't
 * past that yet (a stop at or past the price would sell the rest at once).
 */
export function bankPartial(p: ExitState, price: number): Pick<ExitState, "bankedQuantity" | "bankedPrice" | "stopLoss"> {
  const buffer = breakevenBuffer(p.symbol);
  const dir = p.direction === "LONG" ? 1 : -1;
  const afterCosts = p.entryPrice * (1 + dir * buffer);
  const lock = (price - afterCosts) * dir > 0 ? afterCosts : p.entryPrice;
  return {
    bankedQuantity: p.partialQuantity,
    bankedPrice: price,
    stopLoss: p.direction === "LONG" ? Math.max(p.stopLoss, lock) : Math.min(p.stopLoss, lock),
  };
}

/** Average exit price over the banked part and the rest closed at `exitPrice`. */
export function blendedExitPrice(p: Pick<ExitState, "quantity" | "bankedQuantity" | "bankedPrice">, exitPrice: number): number {
  const banked = p.bankedQuantity ?? 0;
  if (!(banked > 0) || p.bankedPrice === undefined || p.quantity <= 0) return exitPrice;
  return (banked * p.bankedPrice + (p.quantity - banked) * exitPrice) / p.quantity;
}

/**
 * Half the quantity, fitted to the exchange's rules, when both halves are
 * big enough to trade on their own; otherwise nothing is banked early.
 */
export function planPartialQuantity(quantity: number, price: number, rule: Pick<MarketRule, "quantityStep" | "quantityPrecision" | "minQuantity" | "minNotional">): number | undefined {
  const half = floorToStep(quantity / 2, rule);
  const rest = quantity - half;
  const tradable = (q: number) => q > 0 && q >= rule.minQuantity && q * price >= rule.minNotional;
  return tradable(half) && tradable(rest) ? half : undefined;
}
