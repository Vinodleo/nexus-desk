import type { SlowStrategy } from "../types";
import { isNseSymbol, NSE_UNIVERSE } from "./nse";
import { isUsSymbol, US_UNIVERSE, usTicker } from "./usMarket";

// How much goes into each trade, how much it may lose, and how many trades
// can be open at once, set separately for coins (CoinDCX), Indian stocks
// (Angel One) and US stocks (Alpaca, paper). You change them
// in Settings, paper or live; the app and the server's autopilot both
// apply them. (Live orders are also held to the server's own caps, the
// LIVE_* settings, whatever these say.)
//
// Each trade is sized so that its stop loses the market's risk per trade
// (1R): a trade with a stop twice as far away is half the size. The amount
// per trade still caps it, so a trade whose stop is very close risks less.

export type MarketKey = "coins" | "stocks" | "us";
export const MARKET_KEYS: MarketKey[] = ["coins", "stocks", "us"];

export interface MarketLimit {
  /** Rupees put into each trade. A trade can be smaller, never larger. */
  amountPerTradeInr: number;
  /** Trades open at the same time in this market. */
  maxOpenTrades: number;
  /**
   * Rupees a trade loses if it's stopped out (1R, before fees): it's sized to
   * that. cleanMarketLimits fills it in; without it (limits from an older
   * app), only the amount per trade caps the size.
   */
  riskPerTradeInr?: number;
  /**
   * Breakout 55/20 trades open at the same time in this market (coins and US
   * stocks), on slots of their own: they don't count against maxOpenTrades,
   * and the other trades don't count against these, so the daily traders'
   * many small-edge trades can't keep breakout out. cleanMarketLimits fills it in.
   */
  breakoutTrades?: number;
  /**
   * US momentum's trades open at the same time (US stocks), on slots of
   * their own as breakout's: it holds this week's top 3 at most, so up to 3.
   * cleanMarketLimits fills it in.
   */
  momentumTrades?: number;
}

export type MarketLimits = Record<MarketKey, MarketLimit>;

export const AMOUNT_CHOICES = [1000, 2000, 3000, 5000, 10000, 25000, 50000];
export const MAX_TRADES_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10];
export const RISK_CHOICES = [25, 50, 75, 100, 150, 200, 300, 500, 1000];
/** Breakout slots: none switches breakout off in that market. */
export const BREAKOUT_TRADES_CHOICES = [0, 1, 2, 3, 4, 5, 6, 8, 10];
/** Until you choose: breakout's own slots in each market it trades (none for Indian stocks). */
export const DEFAULT_BREAKOUT_TRADES: Record<MarketKey, number> = { coins: 3, stocks: 0, us: 3 };
/** Momentum's slots: none switches it off; it never holds more than its top 3. */
export const MOMENTUM_TRADES_CHOICES = [0, 1, 2, 3];
/** Until you choose: momentum's own slots (it trades US stocks only). */
export const DEFAULT_MOMENTUM_TRADES: Record<MarketKey, number> = { coins: 0, stocks: 0, us: 3 };

/**
 * Until you choose, a trade may lose 1% of the market's amount per trade
 * (₹50 of ₹5,000). Coin and Indian stock stops sit at least 1.2% away, so
 * each of those trades risks exactly that. US stops are closer (usually under 1%),
 * so the amount still decides their size, as before.
 */
export const DEFAULT_RISK_SHARE_OF_AMOUNT = 0.01;

/** The risk per trade used until you choose one: DEFAULT_RISK_SHARE_OF_AMOUNT of the amount. */
export function defaultRiskPerTrade(amountPerTradeInr: number): number {
  return Math.max(10, Math.round(amountPerTradeInr * DEFAULT_RISK_SHARE_OF_AMOUNT));
}

export const DEFAULT_MARKET_LIMITS: MarketLimits = {
  coins: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 50, breakoutTrades: 3, momentumTrades: 0 },
  stocks: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 50, breakoutTrades: 0, momentumTrades: 0 },
  us: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 50, breakoutTrades: 3, momentumTrades: 3 },
};

export const MARKET_LABEL: Record<MarketKey, string> = { coins: "coin", stocks: "Indian stock", us: "US stock" };

/** Which market a symbol trades in: "AAPL.US" US stocks, "SBIN" Indian stocks, "BTC/INR" coins. */
export const marketOf = (symbol: string | undefined): MarketKey => (isUsSymbol(symbol) ? "us" : isNseSymbol(symbol) ? "stocks" : "coins");

/** Limits as saved or sent, kept to sensible values; anything missing or odd falls back to the default. */
export function cleanMarketLimits(raw: unknown): MarketLimits {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const one = (key: MarketKey): MarketLimit => {
    const d = DEFAULT_MARKET_LIMITS[key];
    const amount = Number(r[key]?.amountPerTradeInr);
    const trades = Number(r[key]?.maxOpenTrades);
    const risk = Number(r[key]?.riskPerTradeInr);
    // Absent (limits from before breakout's slots) reads as NaN: the default.
    const breakout = r[key]?.breakoutTrades === undefined ? NaN : Number(r[key].breakoutTrades);
    const momentum = r[key]?.momentumTrades === undefined ? NaN : Number(r[key].momentumTrades);
    const amountPerTradeInr = Number.isFinite(amount) && amount >= 100 && amount <= 1_000_000 ? Math.round(amount) : d.amountPerTradeInr;
    return {
      amountPerTradeInr,
      maxOpenTrades: Number.isInteger(trades) && trades >= 1 && trades <= 20 ? trades : d.maxOpenTrades,
      // Saved before it existed (or odd): 1% of this market's amount.
      riskPerTradeInr: Number.isFinite(risk) && risk >= 10 && risk <= 100_000 ? Math.round(risk) : defaultRiskPerTrade(amountPerTradeInr),
      breakoutTrades: Number.isInteger(breakout) && breakout >= 0 && breakout <= 20 ? breakout : DEFAULT_BREAKOUT_TRADES[key],
      momentumTrades: Number.isInteger(momentum) && momentum >= 0 && momentum <= 20 ? momentum : DEFAULT_MOMENTUM_TRADES[key],
    };
  };
  return { coins: one("coins"), stocks: one("stocks"), us: one("us") };
}

// Stocks in one sector tend to move together (three banks open at once are
// one bet on banks), so at most a few open trades share a sector: the risk
// policy's maxCorrelatedPositionsPerGroup. Coins have no sectors here: they
// all move with Bitcoin, so the coin count in Settings is their limit.

const SECTOR_LABEL: Record<string, string> = {
  BANK: "banking", FINANCE: "finance", IT: "IT", ENERGY: "energy", FMCG: "FMCG", AUTO: "autos", PHARMA: "pharma and health",
  METALS: "metals", INFRA: "infrastructure", TELECOM: "telecom", CONSUMER: "consumer", INDEX: "index funds", TECH: "tech",
  COMMS: "communications", HEALTH: "health",
};

/** The sector a stock trades in (Indian and US stocks apart), or null for a coin or a stock outside the lists. */
export function sectorOf(symbol: string): { key: string; label: string } | null {
  const sector = isUsSymbol(symbol) ? US_UNIVERSE[usTicker(symbol)] : isNseSymbol(symbol) ? NSE_UNIVERSE[symbol] : undefined;
  if (!sector) return null;
  return { key: `${marketOf(symbol)}:${sector}`, label: SECTOR_LABEL[sector] ?? sector.toLowerCase() };
}

/** Positions open in the same sector as `symbol` (none for a coin). */
export function openInSector<T extends { symbol: string }>(positions: T[], symbol: string): T[] {
  const sector = sectorOf(symbol);
  return sector ? positions.filter((p) => sectorOf(p.symbol)?.key === sector.key) : [];
}

/** Positions open in the same market as `symbol`. */
export function openInMarket<T extends { symbol: string }>(positions: T[], symbol: string): T[] {
  const market = marketOf(symbol);
  return positions.filter((p) => marketOf(p.symbol) === market);
}

export const SLOW_STRATEGIES: SlowStrategy[] = ["breakout", "momentum"];

/** A slower strategy's name as sent (a position synced from the app, an event from the server), or undefined for anything else. */
export const slowStrategyOf = (strategy: unknown): SlowStrategy | undefined =>
  SLOW_STRATEGIES.includes(strategy as SlowStrategy) ? (strategy as SlowStrategy) : undefined;

/**
 * Which slots a trade (or proposal's setup) takes: breakout 55/20's and
 * momentum's have their own; null is the rest's (the 5-minute and daily
 * traders'), the market's trades at once.
 */
export type SlotKind = SlowStrategy | null;
export const slotKindOf = (p: { strategy?: string } | undefined): SlotKind => slowStrategyOf(p?.strategy) ?? null;

/** Positions open in `symbol`'s market on the same slots as a new trade of that kind. */
export function openInSlots<T extends { symbol: string; strategy?: string }>(positions: T[], symbol: string, kind: SlotKind): T[] {
  return openInMarket(positions, symbol).filter((p) => slotKindOf(p) === kind);
}

/** How many trades of a kind may be open at once in a market: breakout's or momentum's own slots, or the rest's. */
export function slotsFor(limit: MarketLimit, kind: SlotKind): number {
  return kind === "breakout" ? limit.breakoutTrades ?? 0 : kind === "momentum" ? limit.momentumTrades ?? 0 : limit.maxOpenTrades;
}
