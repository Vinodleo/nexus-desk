import { MarketBar, OrderBook, RegimeType } from "../types";

export interface SymbolConfig {
  symbol: string;
  name: string;
  basePrice: number;
  tickSize: number;
  lotSize: number;
  volatility: number;
  correlatedGroup: string; // for correlation exposure checks
}

export const SUPPORTED_SYMBOLS: SymbolConfig[] = [
  // 1. INR Crypto Markets
  { symbol: "BTC/INR", name: "Bitcoin / INR", basePrice: 5427250.0, tickSize: 50.0, lotSize: 0.01, volatility: 0.45, correlatedGroup: "CRYPTO_MAJOR" },
  { symbol: "ETH/INR", name: "Ethereum / INR", basePrice: 210800.0, tickSize: 10.0, lotSize: 0.1, volatility: 0.52, correlatedGroup: "CRYPTO_MAJOR" },
  { symbol: "SOL/INR", name: "Solana / INR", basePrice: 13107.0, tickSize: 1.0, lotSize: 1, volatility: 0.65, correlatedGroup: "CRYPTO_ALT" },
  { symbol: "JUP/INR", name: "Jupiter / INR", basePrice: 23.55, tickSize: 0.01, lotSize: 100, volatility: 0.72, correlatedGroup: "CRYPTO_ALT" },
  { symbol: "AVAX/INR", name: "Avalanche / INR", basePrice: 2652.0, tickSize: 0.5, lotSize: 10, volatility: 0.68, correlatedGroup: "CRYPTO_ALT" },
  { symbol: "NEAR/INR", name: "Near Protocol / INR", basePrice: 459.0, tickSize: 0.1, lotSize: 50, volatility: 0.68, correlatedGroup: "CRYPTO_ALT" },
  // XRP/INR is consistently one of CoinDCX's top-5 pairs by volume (alongside
  // BTC/ETH/SOL) — a liquid, real INR market.
  { symbol: "XRP/INR", name: "XRP / INR", basePrice: 139.9, tickSize: 0.05, lotSize: 20, volatility: 0.55, correlatedGroup: "CRYPTO_MAJOR" },
];

export function getSymbolConfig(symbolOrCfg: SymbolConfig | string): SymbolConfig {
  if (typeof symbolOrCfg !== "string") return symbolOrCfg;
  const normalized = symbolOrCfg === "XPR/INR" ? "XRP/INR" : symbolOrCfg;
  return (
    SUPPORTED_SYMBOLS.find((s) => s.symbol === normalized) ||
    SUPPORTED_SYMBOLS[0]
  );
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
export function generateInitialBars(symbolOrCfg: SymbolConfig | string, count = 300): MarketBar[] {
  const symbolCfg = getSymbolConfig(symbolOrCfg);
  const bars: MarketBar[] = [];
  let currentPrice = symbolCfg.basePrice;
  const now = Date.now();
  const stepMs = 5 * 60 * 1000; // 5-minute bars
  const startMs = now - count * stepMs;
  let cumulativeVolumeWeight = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < count; i++) {
    const barTime = new Date(startMs + i * stepMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const drift = (Math.random() - 0.49) * 0.003 * currentPrice;
    const open = Number((currentPrice).toFixed(2));
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
      open,
      high,
      low,
      close,
      volume,
      vwap,
    });
    currentPrice = close;
  }

  // Compute indicators
  const closes = bars.map((b) => b.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);

  return bars.map((bar, idx) => {
    const c = bar.close;
    const atr = Number((bar.high - bar.low).toFixed(2));
    const dev = (ema21[idx] || c) * 0.012;
    return {
      ...bar,
      ema9: Number(ema9[idx].toFixed(2)),
      ema21: Number(ema21[idx].toFixed(2)),
      ema50: Number(ema50[idx].toFixed(2)),
      ema200: Number(ema200[idx].toFixed(2)),
      rsi: Number(rsi[idx].toFixed(1)),
      atr: Math.max(atr, Number((c * 0.003).toFixed(2))),
      adx: Number((22 + Math.sin(idx * 0.3) * 12 + Math.random() * 4).toFixed(1)),
      bbUpper: Number(((ema21[idx] || c) + dev * 2).toFixed(2)),
      bbLower: Number(((ema21[idx] || c) - dev * 2).toFixed(2)),
    };
  });
}

// Generate the next single bar given prior history
export function generateNextBar(bars: MarketBar[], symbolOrCfg: SymbolConfig | string): MarketBar {
  const symbolCfg = getSymbolConfig(symbolOrCfg);
  const prev = bars[bars.length - 1];
  const prevClose = prev ? prev.close : symbolCfg.basePrice;
  const drift = (Math.random() - 0.48) * 0.0035 * prevClose;
  const open = prevClose;
  const deltaH = Math.random() * 0.003 * prevClose;
  const deltaL = Math.random() * 0.003 * prevClose;
  const high = Number((Math.max(open, open + drift) + deltaH).toFixed(2));
  const low = Number((Math.min(open, open + drift) - deltaL).toFixed(2));
  const close = Number((open + drift).toFixed(2));
  const volume = Math.floor(600 + Math.random() * 2400);
  const prevVwap = prev?.vwap || close;
  const vwap = Number(((prevVwap * 0.95) + (close * 0.05)).toFixed(2));

  // Fast indicator updates
  const prevEma9 = prev?.ema9 || close;
  const prevEma21 = prev?.ema21 || close;
  const prevEma50 = prev?.ema50 || close;
  const prevEma200 = prev?.ema200 || close;
  const k9 = 2 / 10;
  const k21 = 2 / 22;
  const k50 = 2 / 51;
  const k200 = 2 / 201;

  const ema9 = Number((close * k9 + prevEma9 * (1 - k9)).toFixed(2));
  const ema21 = Number((close * k21 + prevEma21 * (1 - k21)).toFixed(2));
  const ema50 = Number((close * k50 + prevEma50 * (1 - k50)).toFixed(2));
  const ema200 = Number((close * k200 + prevEma200 * (1 - k200)).toFixed(2));

  const prevRsi = prev?.rsi || 50;
  const change = close - open;
  const rsi = Number(Math.min(85, Math.max(15, prevRsi + (change > 0 ? 1.8 : -1.8) + (Math.random() - 0.5))).toFixed(1));
  const atr = Number(Math.max(high - low, close * 0.0035).toFixed(2));
  const dev = ema21 * 0.012;
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return {
    time,
    open,
    high,
    low,
    close,
    volume,
    vwap,
    ema9,
    ema21,
    ema50,
    ema200,
    rsi,
    adx: Number(Math.min(65, Math.max(12, (prev?.adx || 22) + (Math.random() - 0.48) * 1.5)).toFixed(1)),
    atr,
    bbUpper: Number((ema21 + dev * 2).toFixed(2)),
    bbLower: Number((ema21 - dev * 2).toFixed(2)),
  };
}

// Generate active order book for symbol
export function generateOrderBook(currentPrice: number, tickSize = 0.05, thinLiquidity = false): OrderBook {
  const spreadMultiplier = thinLiquidity ? 4 : 1;
  const spread = Number((tickSize * (2 * spreadMultiplier)).toFixed(2));
  const halfSpread = spread / 2;
  const bids = [];
  const asks = [];
  let cumBid = 0;
  let cumAsk = 0;
  for (let i = 1; i <= 6; i++) {
    const bidPrice = Number((currentPrice - halfSpread - (i - 1) * tickSize * 2).toFixed(2));
    const askPrice = Number((currentPrice + halfSpread + (i - 1) * tickSize * 2).toFixed(2));
    const sizeBase = thinLiquidity ? 0.2 : 2.5;
    const bidSize = Number((sizeBase * (1 + Math.random() * 3) * i).toFixed(2));
    const askSize = Number((sizeBase * (1 + Math.random() * 3) * i).toFixed(2));
    cumBid += bidSize;
    cumAsk += askSize;
    bids.push({ price: bidPrice, size: bidSize, total: Number(cumBid.toFixed(2)) });
    asks.push({ price: askPrice, size: askSize, total: Number(cumAsk.toFixed(2)) });
  }
  const depthScore = thinLiquidity ? 22 : 88;

  return {
    bids,
    asks,
    spread,
    midPrice: currentPrice,
    depthScore,
  };
}

// Classify market regime based on indicators
export function classifyRegime(barOrBars: MarketBar | MarketBar[]): RegimeType {
  const bar = Array.isArray(barOrBars) ? barOrBars[barOrBars.length - 1] : barOrBars;
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

export function decorateBarsWithIndicators(bars: MarketBar[]): MarketBar[] {
  if (bars.length === 0) return [];
  const closes = bars.map((b) => b.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  let cumulativeVolumeWeight = 0;
  let cumulativeVolume = 0;
  return bars.map((bar, idx) => {
    const c = bar.close;
    const atr = Number((bar.high - bar.low).toFixed(2));
    const dev = (ema21[idx] || c) * 0.012;
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativeVolumeWeight += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
    const vwap = cumulativeVolume > 0 ? Number((cumulativeVolumeWeight / cumulativeVolume).toFixed(2)) : c;

    return {
      ...bar,
      vwap,
      ema9: Number(ema9[idx].toFixed(2)),
      ema21: Number(ema21[idx].toFixed(2)),
      ema50: Number(ema50[idx].toFixed(2)),
      ema200: Number(ema200[idx].toFixed(2)),
      rsi: Number(rsi[idx].toFixed(1)),
      atr: Math.max(atr, Number((c * 0.003).toFixed(2))),
      adx: Number((22 + Math.sin(idx * 0.3) * 12 + Math.random() * 4).toFixed(1)),
      bbUpper: Number(((ema21[idx] || c) + dev * 2).toFixed(2)),
      bbLower: Number(((ema21[idx] || c) - dev * 2).toFixed(2)),
    };
  });
}
