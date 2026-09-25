// Closed-trade P&L, shared by the browser book and the server guardian so the
// two can't drift apart.
//
// CoinDCX INR-margin fee schedule: 0.02% maker / 0.05% taker, charged on both
// the entry notional and the exit notional. Entries are market (taker); a
// take-profit exit is treated as a resting limit (maker), every other exit as
// taker. Indian stocks (NSE symbols) are charged Angel One's intraday
// costs instead (shared/nse): brokerage per order, STT, stamp duty, GST.

import { isUsSymbol, US_FEE_RATE_PER_SIDE } from "./usMarket";
import { isNseSymbol, nseTradeCosts } from "./nse";

export const TAKER_FEE_RATE = 0.0005;
export const MAKER_FEE_RATE = 0.0002;

export type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "EXPIRY_TIME" | "MANUAL";

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
