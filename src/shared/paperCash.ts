import { openQuantity } from "./exitRules";
import { entryFee } from "./tradeMath";

// A paper desk is a cash account: a trade ties up what it cost, and the fee
// paid to open it, until it's sold, and what's left is free to trade. The
// paper money (equity) moves only when a trade closes, both fees taken then;
// open profit is on top of it. Live trades aren't counted here: CoinDCX's own
// balance holds those back.

type Held = {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  entryPrice: number;
  quantity: number;
  bankedQuantity?: number;
  isLiveOrder?: boolean;
};

/** What a paper trade ties up: its entry price on the part still held, and the fee paid to open it. */
export function cashTiedUp(p: Held): number {
  return p.entryPrice * openQuantity(p) + entryFee(p.symbol, p.direction ?? "LONG", p.entryPrice * p.quantity);
}

/** What the open paper trades tie up: each one's cost on the part still held, and the fee paid to open it. */
export function moneyInTrades(positions: Held[]): number {
  return positions.filter((p) => !p.isLiveOrder).reduce((sum, p) => sum + cashTiedUp(p), 0);
}

/** The paper money left to trade: the money less what the open paper trades cost (never below zero). */
export function freeCash(money: number, positions: Held[]): number {
  return Math.max(0, money - moneyInTrades(positions));
}
