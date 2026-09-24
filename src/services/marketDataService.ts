import { MarketBar, OrderBook, RegimeType } from "../types";
import { averageTrueRange, directionalIndex } from "./indicators";

export interface SymbolConfig {
  symbol: string;
  name: string;
  basePrice: number;
  tickSize: number;
  volatility: number;
  correlatedGroup: string; // for correlation exposure checks
  assetClass: "crypto" | "equity"; // drives session-hours gating and fee model
}

export const SUPPORTED_SYMBOLS: SymbolConfig[] = [
  // 1. INR Crypto Markets
  {
    symbol: "BTC/INR",
    name: "Bitcoin / INR",
    basePrice: 5427250.0,
    tickSize: 50.0,
    volatility: 0.45,
    correlatedGroup: "CRYPTO_MAJOR",
    assetClass: "crypto",
  },
  {
    symbol: "ETH/INR",
    name: "Ethereum / INR",
    basePrice: 210800.0,
    tickSize: 10.0,
    volatility: 0.52,
    correlatedGroup: "CRYPTO_MAJOR",
    assetClass: "crypto",
  },
  {
    symbol: "SOL/INR",
    name: "Solana / INR",
    basePrice: 13107.0,
    tickSize: 1.0,
    volatility: 0.65,
    correlatedGroup: "CRYPTO_ALT",
    assetClass: "crypto",
  },
  {
    symbol: "JUP/INR",
    name: "Jupiter / INR",
    basePrice: 23.55,
    tickSize: 0.01,
    volatility: 0.72,
    correlatedGroup: "CRYPTO_ALT",
    assetClass: "crypto",
  },
  {
    symbol: "AVAX/INR",
    name: "Avalanche / INR",
    basePrice: 2652.0,
    tickSize: 0.5,
    volatility: 0.68,
    correlatedGroup: "CRYPTO_ALT",
    assetClass: "crypto",
  },
  {
    symbol: "NEAR/INR",
    name: "Near Protocol / INR",
    basePrice: 459.0,
    tickSize: 0.1,
    volatility: 0.68,
    correlatedGroup: "CRYPTO_ALT",
    assetClass: "crypto",
  },
  // XRP/INR is consistently one of CoinDCX's top-5 pairs by volume (alongside
  // BTC/ETH/SOL) — a liquid, real INR market.
  {
    symbol: "XRP/INR",
    name: "XRP / INR",
    basePrice: 139.9,
    tickSize: 0.05,
    volatility: 0.55,
    correlatedGroup: "CRYPTO_MAJOR",
    assetClass: "crypto",
  },

  // 2. NSE Equities (Zerodha) — these 4 match the instrument tokens wired
  // in server.ts's KiteTicker subscription. Adding a new one means adding
  // its real NSE instrument token there too, not just a config entry here.
  {
    symbol: "HDFCBANK",
    name: "HDFC Bank",
    basePrice: 731.0,
    tickSize: 0.05,
    volatility: 0.22,
    correlatedGroup: "EQUITY_BANK",
    assetClass: "equity",
  },
  {
    symbol: "RELIANCE",
    name: "Reliance Industries",
    basePrice: 1226.4,
    tickSize: 0.05,
    volatility: 0.20,
    correlatedGroup: "EQUITY_ENERGY",
    assetClass: "equity",
  },
  {
    symbol: "TCS",
    name: "Tata Consultancy Services",
    basePrice: 2105.0,
    tickSize: 0.05,
    volatility: 0.18,
    correlatedGroup: "EQUITY_IT",
    assetClass: "equity",
  },
  {
    symbol: "SBIN",
    name: "State Bank of India",
    basePrice: 996.2,
    tickSize: 0.05,
    volatility: 0.24,
    correlatedGroup: "EQUITY_BANK",
    assetClass: "equity",
  },
  // Expanded for sector coverage the desk didn't have: FMCG, Auto, Pharma,
  // Telecom, plus a second Bank/IT option for liquidity choice within a
  // sector. All picked from Nifty 50/liquid F&O names, not thin small-caps.
  {
    symbol: "ICICIBANK",
    name: "ICICI Bank",
    basePrice: 1338.9,
    tickSize: 0.05,
    volatility: 0.23,
    correlatedGroup: "EQUITY_BANK",
    assetClass: "equity",
  },
  {
    symbol: "INFY",
    name: "Infosys",
    basePrice: 1036.9,
    tickSize: 0.05,
    volatility: 0.19,
    correlatedGroup: "EQUITY_IT",
    assetClass: "equity",
  },
  {
    symbol: "HINDUNILVR",
    name: "Hindustan Unilever",
    basePrice: 1932.0,
    tickSize: 0.05,
    volatility: 0.15,
    correlatedGroup: "EQUITY_FMCG",
    assetClass: "equity",
  },
  {
    symbol: "TATAMOTORS",
    name: "Tata Motors",
    basePrice: 780.0,
    tickSize: 0.05,
    volatility: 0.28,
    correlatedGroup: "EQUITY_AUTO",
    assetClass: "equity",
  },
  {
    symbol: "SUNPHARMA",
    name: "Sun Pharmaceutical Industries",
    basePrice: 1946.0,
    tickSize: 0.05,
    volatility: 0.19,
    correlatedGroup: "EQUITY_PHARMA",
    assetClass: "equity",
  },
  {
    symbol: "BHARTIARTL",
    name: "Bharti Airtel",
    basePrice: 1893.3,
    tickSize: 0.05,
    volatility: 0.21,
    correlatedGroup: "EQUITY_TELECOM",
    assetClass: "equity",
  },
];

/**
 * Indian equity cash-market session: 9:15 AM - 3:30 PM IST, Monday-Friday.
 * Crypto (assetClass "crypto") is unaffected — it trades 24/7. Equities
 * scanned or held outside this window is exactly the "trading NIFTY stocks
 * at 2 AM IST" problem — this is what prevents that.
 */
export function isIndianEquityMarketOpen(): boolean {
  const nowIst = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const day = nowIst.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;

  const minutesSinceMidnight = nowIst.getHours() * 60 + nowIst.getMinutes();
  const marketOpen = 9 * 60 + 15; // 9:15 AM
  const marketClose = 15 * 60 + 30; // 3:30 PM
  return minutesSinceMidnight >= marketOpen && minutesSinceMidnight <= marketClose;
}

// Configs for INR coins outside SUPPORTED_SYMBOLS, which the scanner picks up
// from CoinDCX's most-traded list.
const dynamicConfigs = new Map<string, SymbolConfig>();

/** True for a CoinDCX INR coin symbol like "PEPE/INR". */
export function isCryptoInrSymbol(symbol: string): boolean {
  return /^[A-Z0-9]{1,15}\/INR$/.test(symbol);
}

export function getSymbolConfig(symbolOrCfg: SymbolConfig | string): SymbolConfig {
  if (typeof symbolOrCfg !== "string") return symbolOrCfg;
  const normalized = symbolOrCfg === "XPR/INR" ? "XRP/INR" : symbolOrCfg;
  const known = SUPPORTED_SYMBOLS.find((s) => s.symbol === normalized);
  if (known) return known;
  if (!isCryptoInrSymbol(normalized)) return SUPPORTED_SYMBOLS[0];
  let cfg = dynamicConfigs.get(normalized);
  if (!cfg) {
    const base = normalized.split("/")[0];
    cfg = {
      symbol: normalized,
      name: `${base} / INR`,
      basePrice: 0,
      tickSize: 0.01,
      volatility: 0.75,
      correlatedGroup: "CRYPTO_ALT",
      assetClass: "crypto",
    };
    dynamicConfigs.set(normalized, cfg);
  }
  return cfg;
}

// Helper: Calculate EMA array
function calculateEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const emaArray: number[] = [];
  let prevEma = values[0];
  emaArray.push(prevEma);

  for (let i = 1; i < values.length; i++) {
    const currentEma = values[i] * k + prevEma * (1 - k);
    emaArray.push(currentEma);
    prevEma = currentEma;
  }
  return emaArray;
}

// Helper: Calculate RSI
function calculateRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = [];
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi.push(100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push(100 - 100 / (1 + rs));
  }

  // Prepend padding
  while (rsi.length < closes.length) {
    rsi.unshift(50);
  }
  return rsi;
}

// Generate realistic synthetic initial history
export function generateInitialBars(
  symbolOrCfg: SymbolConfig | string,
  count = 300
): MarketBar[] {
  const symbolCfg = getSymbolConfig(symbolOrCfg);
  const bars: MarketBar[] = [];
  let currentPrice = symbolCfg.basePrice;
  const now = Date.now();
  const stepMs = 5 * 60 * 1000; // 5-minute bars
  const startMs = now - count * stepMs;
  let cumulativeVolumeWeight = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < count; i++) {
    const barTime = new Date(startMs + i * stepMs).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const drift = (Math.random() - 0.49) * 0.003 * currentPrice;
    const open = Number(currentPrice.toFixed(2));
    const deltaH = Math.random() * 0.004 * currentPrice;
    const deltaL = Math.random() * 0.004 * currentPrice;
    const high = Number((Math.max(open, open + drift) + deltaH).toFixed(2));
    const low = Number((Math.min(open, open + drift) - deltaL).toFixed(2));
    const close = Number((open + drift).toFixed(2));
    const volume = Math.floor(500 + Math.random() * 2500);
    const typicalPrice = (high + low + close) / 3;
    cumulativeVolumeWeight += typicalPrice * volume;
    cumulativeVolume += volume;
    const vwap = Number((cumulativeVolumeWeight / cumulativeVolume).toFixed(2));

    bars.push({
      time: barTime,
      isSynthetic: true,
      open,
      high,
      low,
      close,
      volume,
      vwap,
    });
    currentPrice = close;
  }

  return decorateBarsWithIndicators(bars);
}

// Generate active order book for symbol
export function generateOrderBook(
  currentPrice: number,
  tickSize = 0.05,
  thinLiquidity = false
): OrderBook {
  const spreadMultiplier = thinLiquidity ? 4 : 1;
  const spread = Number((tickSize * (2 * spreadMultiplier)).toFixed(2));
  const halfSpread = spread / 2;
  const bids = [];
  const asks = [];
  let cumBid = 0;
  let cumAsk = 0;

  for (let i = 1; i <= 6; i++) {
    const bidPrice = Number(
      (currentPrice - halfSpread - (i - 1) * tickSize * 2).toFixed(2)
    );
    const askPrice = Number(
      (currentPrice + halfSpread + (i - 1) * tickSize * 2).toFixed(2)
    );
    const sizeBase = thinLiquidity ? 0.2 : 2.5;
    const bidSize = Number((sizeBase * (1 + Math.random() * 3) * i).toFixed(2));
    const askSize = Number((sizeBase * (1 + Math.random() * 3) * i).toFixed(2));
    cumBid += bidSize;
    cumAsk += askSize;
    bids.push({
      price: bidPrice,
      size: bidSize,
      total: Number(cumBid.toFixed(2)),
    });
    asks.push({
      price: askPrice,
      size: askSize,
      total: Number(cumAsk.toFixed(2)),
    });
  }
  const depthScore = thinLiquidity ? 22 : 88;

  return {
    bids,
    asks,
    spread,
    midPrice: currentPrice,
    depthScore,
    source: "simulated",
  };
}

// Classify market regime based on indicators
export function classifyRegime(
  barOrBars: MarketBar | MarketBar[]
): RegimeType {
  const bar = Array.isArray(barOrBars)
    ? barOrBars[barOrBars.length - 1]
    : barOrBars;
  if (!bar) return "ranging_wide";
  const adx = bar.adx || 20;
  const atr = bar.atr || 1;
  const atrPercent = (atr / bar.close) * 100;
  const ema9 = bar.ema9 || bar.close;
  const ema21 = bar.ema21 || bar.close;

  if (atrPercent > 2.0) {
    return "high_volatility_choppy";
  }
  if (adx > 25) {
    return ema9 > ema21 ? "trending_bullish" : "trending_bearish";
  }
  if (atrPercent < 0.6) {
    return "ranging_tight";
  }
  return "ranging_wide";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Adds EMAs, RSI, ATR, ADX, Bollinger bands and VWAP to each bar. ATR and
 * ADX are the standard 14-bar Wilder versions (see indicators.ts); VWAP
 * restarts at each UTC day, so it doesn't depend on how many bars are loaded.
 */
export function decorateBarsWithIndicators(
  bars: MarketBar[]
): MarketBar[] {
  if (bars.length === 0) return [];
  const closes = bars.map((b) => b.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  const atr = averageTrueRange(bars);
  const { adx } = directionalIndex(bars);
  let vwapDay = -1;
  let cumulativeVolumeWeight = 0;
  let cumulativeVolume = 0;

  return bars.map((bar, idx) => {
    const c = bar.close;
    const dev = (ema21[idx] || c) * 0.012;
    const day = bar.timestampMs ? Math.floor(bar.timestampMs / DAY_MS) : 0;
    if (day !== vwapDay) {
      vwapDay = day;
      cumulativeVolumeWeight = 0;
      cumulativeVolume = 0;
    }
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativeVolumeWeight += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
    const vwap = cumulativeVolume > 0 ? cumulativeVolumeWeight / cumulativeVolume : c;
    const barAtr = atr[idx] ?? bar.high - bar.low;

    return {
      ...bar,
      vwap: round(vwap),
      ema9: round(ema9[idx]),
      ema21: round(ema21[idx]),
      ema50: round(ema50[idx]),
      ema200: round(ema200[idx]),
      rsi: Number(rsi[idx].toFixed(1)),
      atr: round(barAtr),
      adx: adx[idx] === undefined ? undefined : Number((adx[idx] as number).toFixed(1)),
      bbUpper: round((ema21[idx] || c) + dev * 2),
      bbLower: round((ema21[idx] || c) - dev * 2),
    };
  });
}

/** Keeps enough significant digits for low-priced coins (e.g. ₹0.0123). */
function round(v: number): number {
  const abs = Math.abs(v);
  const decimals = abs >= 100 ? 2 : abs >= 1 ? 4 : 8;
  return Number(v.toFixed(decimals));
}
