// The live test order (server/liveTest.ts): one small real CoinDCX buy and
// its sale, through the same path every live trade takes, to see live orders
// work before any strategy trades real money. What the server reports, and
// how Settings puts it in words.

import { COIN_SALE_TDS } from "./tradeMath";

/** What the test buys, in rupees: over CoinDCX's usual ₹100 minimum with room for the fee and a small fall. */
export const TEST_ORDER_INR = 200;
/** What it needs at CoinDCX: the order and its fee. */
export const TEST_NEEDS_INR = 205;

/**
 * BOUGHT: the coin is held and waits for "Sell it". SELLING: the sale was
 * sent and not yet confirmed, or CoinDCX refused it and the server keeps
 * trying. SOLD: done. SELL_FAILED: the server gave up (sell it by hand).
 */
export type LiveTestStatus = "BOUGHT" | "SELLING" | "SOLD" | "SELL_FAILED";

export interface LiveTestRun {
  positionId: string;
  market: string;
  coin: string;
  status: LiveTestStatus;
  /** The quantity bought (sent and accepted). */
  quantity: number;
  boughtAt: string;
  buyOrderId: string;
  /** CoinDCX's average price for the buy. */
  buyPrice?: number;
  /** How much the coin held at CoinDCX went up: the whole quantity, or less when the fee came out of the coins. */
  coinReceived?: number;
  /** How much the rupees went down (the order and its fee). */
  inrSpent?: number;
  soldAt?: string;
  sellPrice?: number;
  /** How much the rupees went up from the sale. */
  inrReceived?: number;
  /** CoinDCX's last refusal of the sale. */
  error?: string;
  /** The server is still reading CoinDCX's balances after the last order (they can take a few seconds to show it). */
  settling?: boolean;
  /** The balances never showed the order. */
  balanceNote?: string;
}

export interface LiveTestReport {
  /** CoinDCX keys on the server. */
  keys: boolean;
  /** LIVE_TRADING_ENABLED is "true" on the server. */
  liveEnabled: boolean;
  /** The coins it can test on (LIVE_ALLOWED_MARKETS). */
  markets: string[];
  amountInr: number;
  run: LiveTestRun | null;
}

const qty = (x: number) => String(Number(x.toPrecision(6)));
const inr = (x: number) => `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Whether the fee came out of the coins: what CoinDCX holds of the buy is a
 * little under the quantity bought. Unknown until the balances showed the
 * buy: a holding under half the quantity means they hadn't caught up (the
 * first test's early read said 0), not a fee.
 */
export function feeFromCoins(run: LiveTestRun): boolean | undefined {
  const got = run.coinReceived;
  if (got === undefined || !(got > run.quantity * 0.5)) return undefined;
  return got < run.quantity * (1 - 1e-4);
}

/**
 * What the round trip cost, split into CoinDCX's fees, the TDS withheld from
 * the sale (reclaimed when filing) and the price move; once all four figures
 * are known.
 */
export function roundTripCost(run: LiveTestRun): { total: number; fees: number; tds: number; move: number } | undefined {
  const { inrSpent, inrReceived, buyPrice, sellPrice, quantity } = run;
  if (!(inrSpent && inrSpent > 0) || !(inrReceived && inrReceived > 0) || !buyPrice || !sellPrice) return undefined;
  const bought = quantity * buyPrice;
  const sold = quantity * sellPrice;
  const tds = sold * COIN_SALE_TDS;
  const round = (x: number) => Number(x.toFixed(2));
  return { total: round(inrSpent - inrReceived), fees: round(inrSpent - bought + (sold - tds - inrReceived)), tds: round(tds), move: round(bought - sold) };
}

/** The test's result in plain words, one line each. */
export function liveTestLines(run: LiveTestRun): string[] {
  const lines: string[] = [];
  const price = run.buyPrice ? ` at ${inr(run.buyPrice)}` : "";
  const spent = run.inrSpent && run.inrSpent > 0 ? ` (${inr(run.inrSpent)} spent with the fee)` : "";
  lines.push(`Bought ${qty(run.quantity)} ${run.coin}${price}${spent}.`);
  const fromCoins = feeFromCoins(run);
  if (fromCoins === true) {
    const short = ((run.quantity - run.coinReceived!) / run.quantity) * 100;
    lines.push(`CoinDCX holds ${qty(run.coinReceived!)} of it, ${short.toFixed(2)}% less: the fee came out of the coins, so a sale of the whole ${qty(run.quantity)} may be refused.`);
  } else if (fromCoins === false) {
    lines.push(`CoinDCX holds all ${qty(run.quantity)}: the fee came out of rupees, so sales of the whole quantity work.`);
  }
  if (run.status === "SELLING") {
    lines.push(run.error ? `The sale was refused (${run.error}). The server keeps trying; if it doesn't go through, sell it on CoinDCX by hand.` : "Selling…");
  } else if (run.status === "SELL_FAILED") {
    lines.push(`The sale failed${run.error ? ` (${run.error})` : ""}. Sell it on CoinDCX by hand.`);
  } else if (run.status === "SOLD") {
    const at = run.sellPrice ? ` at ${inr(run.sellPrice)}` : "";
    const back = run.inrReceived && run.inrReceived > 0 ? `: ${inr(run.inrReceived)} back` : "";
    lines.push(`Sold${at}${back}.`);
    const cost = roundTripCost(run);
    if (cost) {
      const what = cost.total >= 0 ? `cost ${inr(cost.total)}` : `made ${inr(-cost.total)}`;
      lines.push(
        `The round trip ${what}: ${inr(cost.fees)} in fees, ${inr(cost.tds)} TDS (reclaimed when you file), and the price ${cost.move >= 0 ? "fell" : "rose"} ${inr(Math.abs(cost.move))}.`
      );
    }
  }
  if (run.settling) lines.push("Reading CoinDCX's balance (it can take a few seconds to show an order)…");
  if (run.balanceNote) lines.push(run.balanceNote);
  return lines;
}
