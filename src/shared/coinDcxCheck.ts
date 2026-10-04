// The daily check against CoinDCX (server/coinDcxCheck.ts): what the server
// reports to Settings, and how a mismatch is put in words, the same in the
// pop-up and in Settings.

/**
 * - missing: CoinDCX holds well under what the open live trades bought (sold
 *   or moved outside the app, or a buy that didn't fill).
 * - fee: a little under (up to 1%): most likely CoinDCX took the buying fee
 *   in coins, and a sell of the whole quantity would be refused.
 * - unsold: a live exit failed and the coins are still there.
 */
export type CoinProblemKind = "missing" | "fee" | "unsold";

export interface CoinProblem {
  coin: string;
  kind: CoinProblemKind;
  /** What the app's trades say should be there (for "unsold": what the failed exit should have sold). */
  expected: number;
  /** What CoinDCX holds (for "unsold": beyond the open trades). */
  held: number;
  /** The live positions it concerns. */
  positions: string[];
}

export interface CoinDcxCheckReport {
  /** Whether the server has CoinDCX keys: without them there's nothing to check (paper trading needs none). */
  configured: boolean;
  /** The last check that read CoinDCX's balances, and the last try (ms). */
  lastAt: number | null;
  lastTriedAt: number | null;
  /** The open live trades it compared, and their coins. */
  trades: number;
  coins: string[];
  /** Mismatches seen on two checks in a row (a first sighting is checked again 5 minutes later). */
  problems: CoinProblem[];
  /** Coins held at CoinDCX beyond the live trades (the owner's own, or left over): shown, never popped up. */
  extras: Array<{ coin: string; held: number }>;
  lastError: string | null;
  lastErrorAt: number | null;
  /** Live trades open now (it checks hourly while there are any). */
  liveTrades: number;
}

/** A coin quantity, short: 0.00199, 0.002, 12.5. */
export const coinQty = (x: number) => String(Number(x.toPrecision(6)));

const pctShort = (p: CoinProblem) => (p.expected > 0 ? Math.max(0.01, Math.round(((p.expected - p.held) / p.expected) * 10000) / 100) : 0);

/** The pop-up for a mismatch. */
export function coinProblemMessage(p: CoinProblem): { title: string; body: string } {
  switch (p.kind) {
    case "fee":
      return {
        title: `CoinDCX check: ${p.coin} a little short`,
        body: `CoinDCX has ${coinQty(p.held)} ${p.coin}, ${pctShort(p)}% under the ${coinQty(p.expected)} the live trade bought: likely the buying fee, taken in coins. A sell of ${coinQty(p.expected)} would be refused, so close it at CoinDCX by hand.`,
      };
    case "missing":
      return {
        title: `CoinDCX check: ${p.coin} missing`,
        body: `The app's live trades hold ${coinQty(p.expected)} ${p.coin}, but CoinDCX has ${coinQty(p.held)}. Sold or moved outside the app? The server can't sell what isn't there: check CoinDCX.`,
      };
    case "unsold":
      return {
        title: `CoinDCX check: ${p.coin} still held`,
        body: `A live exit failed and CoinDCX still holds ${coinQty(p.held)} ${p.coin}. Sell it there by hand.`,
      };
  }
}

/** One line for Settings. */
export function coinProblemLine(p: CoinProblem): string {
  switch (p.kind) {
    case "fee":
      return `${p.coin}: ${pctShort(p)}% under the live trade's ${coinQty(p.expected)} (likely the fee); close it at CoinDCX`;
    case "missing":
      return `${p.coin}: CoinDCX has ${coinQty(p.held)}, the live trades hold ${coinQty(p.expected)}`;
    case "unsold":
      return `${p.coin}: ${coinQty(p.held)} still held after a failed exit; sell it at CoinDCX`;
  }
}
