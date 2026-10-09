// Closed-trade P&L, shared by the browser book and the server guardian so the
// two can't drift apart.
//
// CoinDCX INR spot fees, as its order screens show them (the live test order,
// Oct 2026): 0.5% of each order's value plus 18% GST on that fee, so 0.59%
// a side, in rupees, on the entry notional and the exit notional. (The
// 0.02% / 0.05% schedule used before was CoinDCX's futures one.) No lower
// rate for resting limit orders is known, so a take-profit pays the same. A
// sale also has 1% TDS withheld (India's tax on crypto transfers): income tax
// paid in advance, reclaimed when filing, so it isn't counted as a trading
// cost. Indian stocks (NSE symbols) are charged Angel One's intraday costs
// instead (shared/nse): brokerage per order, STT, stamp duty, GST.

import { isUsSymbol, US_FEE_RATE_PER_SIDE } from "./usMarket";
import { GST_RATE, isNseSymbol, nseTradeCosts } from "./nse";

/** CoinDCX's fee on an INR spot order, before GST. */
export const COINDCX_FEE = 0.005;
/** What a coin order costs a side: the fee and its GST (0.59%). */
export const COIN_FEE_PER_SIDE = Number((COINDCX_FEE * (1 + GST_RATE)).toFixed(6));
export const TAKER_FEE_RATE = COIN_FEE_PER_SIDE;
export const MAKER_FEE_RATE = COIN_FEE_PER_SIDE;
/** India's tax withheld on each crypto sale (reclaimed when filing; not a trading cost). */
export const COIN_SALE_TDS = 0.01;

export type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "EXPIRY_TIME" | "MANUAL";

/**
 * The fee paid to open a trade of this value, as the close counts it in
 * computeClosedTradePnl: Alpaca's regulatory fees for a US stock, Angel One's
 * charges for the opening order on an Indian one, CoinDCX's fee for a coin.
 */
export function entryFee(symbol: string | undefined, direction: "LONG" | "SHORT", notional: number): number {
  if (!(notional > 0)) return 0;
  if (isUsSymbol(symbol)) return notional * US_FEE_RATE_PER_SIDE;
  if (isNseSymbol(symbol)) return nseTradeCosts([{ side: direction === "LONG" ? "BUY" : "SELL", value: notional }]);
  return notional * TAKER_FEE_RATE;
}

export interface ClosedTradePnl {
  grossPnl: number;
  feesPaid: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  entryNotional: number;
  isWin: boolean;
}

/**
 * @param banked part of the position closed earlier (at +1R, as a resting
 *   limit, so at the maker rate); `exitPrice` and `reason` apply to the rest.
 * @param symbol decides the fee schedule: an NSE stock, or crypto (default).
 */
export function computeClosedTradePnl(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  reason: ExitReason,
  banked?: { quantity: number; price: number },
  symbol?: string
): ClosedTradePnl {
  const bankedQty = banked && banked.quantity > 0 && banked.quantity < quantity ? banked.quantity : 0;
  const restQty = quantity - bankedQty;
  const gain = (exit: number) => (direction === "LONG" ? exit - entryPrice : entryPrice - exit);
  const grossPnl = Number((gain(exitPrice) * restQty + (bankedQty > 0 ? gain(banked!.price) * bankedQty : 0)).toFixed(2));

  const entryNotional = entryPrice * quantity;
  let fees: number;
  if (isUsSymbol(symbol)) {
    // Commission-free; regulatory fees only.
    fees = (entryNotional + exitPrice * restQty + (bankedQty > 0 ? banked!.price * bankedQty : 0)) * US_FEE_RATE_PER_SIDE;
  } else if (isNseSymbol(symbol)) {
    const open = direction === "LONG" ? "BUY" : "SELL";
    const close = direction === "LONG" ? "SELL" : "BUY";
    fees = nseTradeCosts([
      { side: open, value: entryNotional },
      { side: close, value: exitPrice * restQty },
      ...(bankedQty > 0 ? [{ side: close, value: banked!.price * bankedQty } as const] : []),
    ]);
  } else {
    const closeFeeRate = reason === "TAKE_PROFIT" ? MAKER_FEE_RATE : TAKER_FEE_RATE;
    const exitFees = exitPrice * restQty * closeFeeRate + (bankedQty > 0 ? banked!.price * bankedQty * MAKER_FEE_RATE : 0);
    fees = entryNotional * TAKER_FEE_RATE + exitFees;
  }
  const feesPaid = Number(fees.toFixed(2));

  const realizedPnl = Number((grossPnl - feesPaid).toFixed(2));
  const realizedPnlPercent = Number(((realizedPnl / entryNotional) * 100).toFixed(2));

  return { grossPnl, feesPaid, realizedPnl, realizedPnlPercent, entryNotional, isWin: realizedPnl >= 0 };
}
