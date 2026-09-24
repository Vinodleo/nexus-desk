// Which CoinDCX INR coins the scanner watches: the most traded ones, by 24-hour
// rupee volume from CoinDCX's ticker. Busy markets have tighter spreads and
// real moves; the list is refreshed hourly so it follows where the trading is.

export const UNIVERSE_SIZE = 25;
/** A coin trading less than this in 24 hours is left out whatever its rank. */
export const MIN_DAILY_VOLUME_INR = 1_000_000;
/** Used until CoinDCX's ticker has been read, or if it can't be. */
export const DEFAULT_COINS = ["BTC", "ETH", "SOL", "AVAX", "NEAR", "JUP", "XRP"];
/** Pegged to a currency, so there's nothing to trade on a 5-minute chart. */
const STABLECOINS = new Set(["USDT", "USDC", "DAI", "FDUSD", "TUSD", "BUSD", "USDP", "PYUSD", "USDE", "USDS", "EURT", "EURC"]);

export interface UniverseCoin {
  /** App symbol, e.g. "BTC/INR". */
  symbol: string;
  /** 24-hour traded value in rupees. */
  volumeInr: number;
}

export interface CoinUniverse {
  coins: UniverseCoin[];
  updatedAt: number;
  /** True when this is the default list because CoinDCX's ticker couldn't be used. */
  fallback: boolean;
}

export function defaultUniverse(now: number = Date.now()): CoinUniverse {
  return { coins: DEFAULT_COINS.map((c) => ({ symbol: `${c}/INR`, volumeInr: 0 })), updatedAt: now, fallback: true };
}

/**
 * The top coins from CoinDCX's /exchange/ticker. Its `volume` for a market is
 * in the quote currency, so for INR markets it's already rupees. When
 * `activeMarkets` is given (from the market rules), only those are kept.
 */
export function pickTopCoins(
  tickers: unknown,
  opts: { size?: number; minVolumeInr?: number; activeMarkets?: Set<string> } = {}
): UniverseCoin[] {
  if (!Array.isArray(tickers)) return [];
  const size = opts.size ?? UNIVERSE_SIZE;
  const minVolume = opts.minVolumeInr ?? MIN_DAILY_VOLUME_INR;
  const byCoin = new Map<string, UniverseCoin>();
  for (const t of tickers as Record<string, unknown>[]) {
    const market = typeof t?.market === "string" ? t.market.toUpperCase() : "";
    if (!market.endsWith("INR")) continue;
    const base = market.slice(0, -3);
    if (!/^[A-Z0-9]{1,15}$/.test(base) || STABLECOINS.has(base)) continue;
    if (opts.activeMarkets && opts.activeMarkets.size > 0 && !opts.activeMarkets.has(market)) continue;
    const volumeInr = Number(t.volume);
    const price = Number(t.last_price);
    if (!(volumeInr >= minVolume) || !(price > 0)) continue;
    const symbol = `${base}/INR`;
    if ((byCoin.get(symbol)?.volumeInr ?? -1) < volumeInr) byCoin.set(symbol, { symbol, volumeInr });
  }
  return [...byCoin.values()].sort((a, b) => b.volumeInr - a.volumeInr).slice(0, size);
}
