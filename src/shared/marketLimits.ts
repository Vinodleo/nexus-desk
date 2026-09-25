import { isNseSymbol } from "./nse";

// How much goes into each trade, and how many trades can be open at once,
// set separately for coins (CoinDCX) and stocks (Angel One). You change them
// in Settings, paper or live; the app and the server's autopilot both
// apply them. (Live orders are also held to the server's own caps, the
// LIVE_* settings, whatever these say.)

export type MarketKey = "coins" | "stocks";

export interface MarketLimit {
  /** Rupees put into each trade. A trade can be smaller, never larger. */
  amountPerTradeInr: number;
  /** Trades open at the same time in this market. */
  maxOpenTrades: number;
}

export type MarketLimits = Record<MarketKey, MarketLimit>;

export const AMOUNT_CHOICES = [1000, 2000, 3000, 5000, 10000, 25000, 50000];
export const MAX_TRADES_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10];

export const DEFAULT_MARKET_LIMITS: MarketLimits = {
  coins: { amountPerTradeInr: 5000, maxOpenTrades: 2 },
  stocks: { amountPerTradeInr: 5000, maxOpenTrades: 2 },
};

export const MARKET_LABEL: Record<MarketKey, string> = { coins: "coin", stocks: "stock" };

export const marketOf = (symbol: string | undefined): MarketKey => (isNseSymbol(symbol) ? "stocks" : "coins");

/** Limits as saved or sent, kept to sensible values; anything missing or odd falls back to the default. */
export function cleanMarketLimits(raw: unknown): MarketLimits {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const one = (key: MarketKey): MarketLimit => {
    const d = DEFAULT_MARKET_LIMITS[key];
    const amount = Number(r[key]?.amountPerTradeInr);
    const trades = Number(r[key]?.maxOpenTrades);
    return {
      amountPerTradeInr: Number.isFinite(amount) && amount >= 100 && amount <= 1_000_000 ? Math.round(amount) : d.amountPerTradeInr,
      maxOpenTrades: Number.isInteger(trades) && trades >= 1 && trades <= 20 ? trades : d.maxOpenTrades,
    };
  };
  return { coins: one("coins"), stocks: one("stocks") };
}

/** Positions open in the same market as `symbol`. */
export function openInMarket<T extends { symbol: string }>(positions: T[], symbol: string): T[] {
  const market = marketOf(symbol);
  return positions.filter((p) => marketOf(p.symbol) === market);
}
