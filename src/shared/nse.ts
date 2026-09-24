// Indian stocks (NSE cash market, intraday): which stocks are scanned, when
// the market takes new trades, when open positions must be closed, and what
// a trade costs at Angel One. Shared by the app and the server.

/** Nifty 50 stocks, by sector (for the correlation check). Symbols Angel One doesn't list are skipped. */
export const NSE_UNIVERSE: Record<string, string> = {
  HDFCBANK: "BANK", ICICIBANK: "BANK", SBIN: "BANK", KOTAKBANK: "BANK", AXISBANK: "BANK",
  BAJFINANCE: "FINANCE", BAJAJFINSV: "FINANCE", SHRIRAMFIN: "FINANCE", JIOFIN: "FINANCE", HDFCLIFE: "FINANCE", SBILIFE: "FINANCE",
  TCS: "IT", INFY: "IT", HCLTECH: "IT", WIPRO: "IT", TECHM: "IT",
  RELIANCE: "ENERGY", ONGC: "ENERGY", NTPC: "ENERGY", POWERGRID: "ENERGY", COALINDIA: "ENERGY",
  HINDUNILVR: "FMCG", ITC: "FMCG", NESTLEIND: "FMCG", TATACONSUM: "FMCG",
  MARUTI: "AUTO", "M&M": "AUTO", "BAJAJ-AUTO": "AUTO", EICHERMOT: "AUTO", TMPV: "AUTO",
  SUNPHARMA: "PHARMA", CIPLA: "PHARMA", DRREDDY: "PHARMA", APOLLOHOSP: "PHARMA", MAXHEALTH: "PHARMA",
  TATASTEEL: "METALS", JSWSTEEL: "METALS", HINDALCO: "METALS",
  LT: "INFRA", ULTRACEMCO: "INFRA", GRASIM: "INFRA", ADANIPORTS: "INFRA", ADANIENT: "INFRA", BEL: "INFRA",
  BHARTIARTL: "TELECOM",
  TITAN: "CONSUMER", ASIANPAINT: "CONSUMER", TRENT: "CONSUMER", ETERNAL: "CONSUMER", INDIGO: "CONSUMER",
};

export const NSE_SYMBOLS = Object.keys(NSE_UNIVERSE);

/** An NSE stock symbol like "SBIN" or "M&M" (crypto symbols carry "/INR"). */
export function isNseSymbol(symbol: string | undefined): boolean {
  return !!symbol && !symbol.includes("/") && /^[A-Z0-9&-]{1,20}$/.test(symbol);
}

// ---------- session (IST, Monday to Friday) ----------

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Minutes after midnight IST. */
export const NSE_OPEN = 9 * 60 + 15;
/** No new trades after this: too little time left for a trade to work before square-off. */
export const NSE_LAST_ENTRY = 15 * 60;
/** Intraday positions are closed at this time, before the broker squares them off itself. */
export const NSE_SQUARE_OFF = 15 * 60 + 20;
export const NSE_CLOSE = 15 * 60 + 30;

function istParts(ms: number): { day: string; weekday: number; minutes: number } {
  const d = new Date(ms + IST_OFFSET_MS);
  return { day: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** The NSE session is on (9:15 to 3:30 IST on a weekday). Exchange holidays aren't known here: no new candles come then. */
export function isNseOpen(nowMs: number = Date.now()): boolean {
  const { weekday, minutes } = istParts(nowMs);
  return weekday >= 1 && weekday <= 5 && minutes >= NSE_OPEN && minutes < NSE_CLOSE;
}

/** New stock trades are taken now (from the open until 3:00 IST). */
export function nseTakesEntries(nowMs: number = Date.now()): boolean {
  return isNseOpen(nowMs) && istParts(nowMs).minutes < NSE_LAST_ENTRY;
}

/** A stock position opened at `openTime` must be closed by now: it's 3:20 IST or later, or a later day. */
export function nseSquareOffDue(openTime: string, nowMs: number = Date.now()): boolean {
  const opened = Date.parse(openTime);
  if (!Number.isFinite(opened)) return false;
  const now = istParts(nowMs);
  return now.day !== istParts(opened).day || now.minutes >= NSE_SQUARE_OFF;
}

/** Start of today's session (9:15 IST) in ms. */
export function nseSessionStart(nowMs: number = Date.now()): number {
  const { day } = istParts(nowMs);
  return Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS + NSE_OPEN * 60_000;
}

// ---------- costs (Angel One, equity intraday) ----------

/** Brokerage per executed order: ₹20 or 0.1% of its value, whichever is lower, at least ₹5. */
export const NSE_BROKERAGE_RATE = 0.001;
export const NSE_BROKERAGE_CAP = 20;
export const NSE_BROKERAGE_MIN = 5;
/** Securities transaction tax, on the sell side. */
export const NSE_STT_SELL = 0.00025;
/** Exchange transaction charges, both sides (rounded up from NSE's rate). */
export const NSE_EXCHANGE_RATE = 0.000035;
/** SEBI turnover fee (₹10 a crore), both sides. */
export const NSE_SEBI_RATE = 0.000001;
/** Stamp duty, on the buy side. */
export const NSE_STAMP_BUY = 0.00003;
export const GST_RATE = 0.18;

/** Everything an intraday stock trade costs: `orders` are the executed orders' values. */
export function nseTradeCosts(orders: { side: "BUY" | "SELL"; value: number }[]): number {
  let brokerage = 0;
  let turnover = 0;
  let stt = 0;
  let stamp = 0;
  for (const o of orders) {
    if (!(o.value > 0)) continue;
    brokerage += Math.max(NSE_BROKERAGE_MIN, Math.min(NSE_BROKERAGE_CAP, o.value * NSE_BROKERAGE_RATE));
    turnover += o.value;
    if (o.side === "SELL") stt += o.value * NSE_STT_SELL;
    else stamp += o.value * NSE_STAMP_BUY;
  }
  const exchange = turnover * NSE_EXCHANGE_RATE;
  const sebi = turnover * NSE_SEBI_RATE;
  return brokerage + exchange + sebi + stt + stamp + GST_RATE * (brokerage + exchange + sebi);
}

/** A round trip's costs as a share of the trade's value (one order in, one out). */
export function nseRoundTripRate(value: number): number {
  if (!(value > 0)) return 0;
  return nseTradeCosts([{ side: "BUY", value }, { side: "SELL", value }]) / value;
}
