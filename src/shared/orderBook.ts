// CoinDCX's order book, and what it means for a trade of a given size: the
// real spread, how far a market order would move the price (slippage), and
// how much is on offer near the price. Shared by the server (parsing) and the
// browser (costs and the liquidity check).

/** One price level: [price, quantity]. */
export type BookLevel = [number, number];

export interface RawBook {
  /** Highest price first. */
  bids: BookLevel[];
  /** Lowest price first. */
  asks: BookLevel[];
  /** When the server read it from CoinDCX (ms). */
  fetchedAt: number;
}

export const BOOK_LEVELS_KEPT = 50;
/** Depth is counted within this distance of the mid price. */
export const DEPTH_BAND = 0.005;
/** How many times the trade has to fit in that band for a full depth score. */
const FULL_DEPTH_MULTIPLE = 20;
/** Depth score when the band holds exactly one trade: the default minimum. */
const ONE_TRADE_SCORE = 35;

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : NaN;
};

function readSide(side: unknown): BookLevel[] {
  const out: BookLevel[] = [];
  const push = (p: unknown, q: unknown) => {
    const price = num(p);
    const qty = num(q);
    if (price > 0 && qty > 0) out.push([price, qty]);
  };
  if (Array.isArray(side)) {
    for (const l of side) {
      if (Array.isArray(l)) push(l[0], l[1]);
      else if (l && typeof l === "object") {
        const o = l as Record<string, unknown>;
        push(o.price ?? o.p, o.quantity ?? o.qty ?? o.q ?? o.size);
      }
    }
  } else if (side && typeof side === "object") {
    // CoinDCX's usual shape: { "5000000.0": "0.012", ... }
    for (const [p, q] of Object.entries(side as Record<string, unknown>)) push(p, q);
  }
  return out;
}

/**
 * Parses CoinDCX's /market_data/orderbook response. Returns null when either
 * side is empty or the book is crossed (bid at or above ask).
 */
export function parseCoinDcxOrderBook(raw: unknown, fetchedAt: number = Date.now()): RawBook | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const bids = readSide(r.bids).sort((a, b) => b[0] - a[0]).slice(0, BOOK_LEVELS_KEPT);
  const asks = readSide(r.asks).sort((a, b) => a[0] - b[0]).slice(0, BOOK_LEVELS_KEPT);
  if (bids.length === 0 || asks.length === 0 || bids[0][0] >= asks[0][0]) return null;
  return { bids, asks, fetchedAt };
}

/**
 * Average fill price for a market order worth `notional` in rupees, walking
 * the levels from the best one. Null when the book can't fill it.
 */
export function averageFill(levels: BookLevel[], notional: number): number | null {
  if (notional <= 0) return levels[0]?.[0] ?? null;
  let spent = 0;
  let qty = 0;
  for (const [price, size] of levels) {
    const take = Math.min(size * price, notional - spent);
    spent += take;
    qty += take / price;
    if (spent >= notional - 1e-9) return spent / qty;
  }
  return null;
}

export interface BookStats {
  bestBid: number;
  bestAsk: number;
  mid: number;
  /** Ask minus bid, in rupees per unit. */
  spread: number;
  spreadPct: number;
  /**
   * Price moved past the best level to buy and then sell `notional`, as a
   * share of the price (entry and exit together). Infinity when the book
   * can't fill it.
   */
  roundTripSlippage: number;
  /** Rupees on offer within DEPTH_BAND of mid, on the thinner side. */
  depthInr: number;
  /** 0-100; ONE_TRADE_SCORE means the band holds exactly one trade. */
  depthScore: number;
}

export function bookStats(book: RawBook, notional: number): BookStats {
  const bestBid = book.bids[0][0];
  const bestAsk = book.asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  const buy = averageFill(book.asks, notional);
  const sell = averageFill(book.bids, notional);
  const roundTripSlippage =
    buy === null || sell === null ? Infinity : (buy - bestAsk) / bestAsk + (bestBid - sell) / bestBid;

  const inBand = (levels: BookLevel[]) =>
    levels.filter(([p]) => Math.abs(p - mid) / mid <= DEPTH_BAND).reduce((s, [p, q]) => s + p * q, 0);
  const depthInr = Math.min(inBand(book.bids), inBand(book.asks));

  return {
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadPct: spread / mid,
    roundTripSlippage,
    depthInr,
    depthScore: depthScoreFor(depthInr, notional),
  };
}

/**
 * Depth score from how many times the trade fits in the band: once scores
 * ONE_TRADE_SCORE, FULL_DEPTH_MULTIPLE times or more scores 100, on a log scale.
 */
export function depthScoreFor(depthInr: number, notional: number): number {
  if (depthInr <= 0) return 0;
  if (notional <= 0) return 100;
  const multiple = depthInr / notional;
  const score = ONE_TRADE_SCORE + ((100 - ONE_TRADE_SCORE) * Math.log10(multiple)) / Math.log10(FULL_DEPTH_MULTIPLE);
  return Math.round(Math.max(0, Math.min(100, score)));
}
