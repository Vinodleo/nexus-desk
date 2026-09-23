// Closed-trade P&L, shared by the browser book and the server guardian so the
// two can't drift apart.
//
// CoinDCX INR-margin fee schedule: 0.02% maker / 0.05% taker, charged on both
// the entry notional and the exit notional. Entries are market (taker); a
// take-profit exit is treated as a resting limit (maker), every other exit as
// taker.

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

export function computeClosedTradePnl(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  reason: ExitReason
): ClosedTradePnl {
  const diff = direction === "LONG" ? exitPrice - entryPrice : entryPrice - exitPrice;
  const grossPnl = Number((diff * quantity).toFixed(2));

  const entryNotional = entryPrice * quantity;
  const exitNotional = exitPrice * quantity;
  const closeFeeRate = reason === "TAKE_PROFIT" ? MAKER_FEE_RATE : TAKER_FEE_RATE;
  const feesPaid = Number((entryNotional * TAKER_FEE_RATE + exitNotional * closeFeeRate).toFixed(2));

  const realizedPnl = Number((grossPnl - feesPaid).toFixed(2));
  const realizedPnlPercent = Number(((realizedPnl / entryNotional) * 100).toFixed(2));

  return { grossPnl, feesPaid, realizedPnl, realizedPnlPercent, entryNotional, isWin: realizedPnl >= 0 };
}
