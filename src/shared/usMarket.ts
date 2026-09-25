// US stocks (paper, data from Alpaca): which are scanned, when the market
// takes new trades, when open positions must be closed, and what a trade
// costs. Shared by the app and the server.
//
// Symbols carry ".US" ("AAPL.US") so they're never mistaken for an NSE stock
// or a coin. Prices are kept in rupees, converted at the day's USD/INR rate
// (server/fx.ts), so the book, the limits and P&L stay in one currency.
// Long only: an Indian resident's LRS account can't sell short.

/** Highly liquid US stocks and ETFs, by sector (for the correlation check). */
export const US_UNIVERSE: Record<string, string> = {
  SPY: "INDEX", QQQ: "INDEX", IWM: "INDEX",
  AAPL: "TECH", MSFT: "TECH", NVDA: "TECH", AVGO: "TECH", AMD: "TECH", ORCL: "TECH", CRM: "TECH", ADBE: "TECH", INTC: "TECH", PLTR: "TECH",
  AMZN: "CONSUMER", TSLA: "CONSUMER", COST: "CONSUMER", WMT: "CONSUMER", KO: "CONSUMER", PEP: "CONSUMER",
  GOOGL: "COMMS", META: "COMMS", NFLX: "COMMS", DIS: "COMMS", UBER: "COMMS",
  JPM: "FINANCE", BAC: "FINANCE", V: "FINANCE", MA: "FINANCE",
  XOM: "ENERGY", UNH: "HEALTH", LLY: "HEALTH",
};

export const US_SUFFIX = ".US";
export const US_SYMBOLS = Object.keys(US_UNIVERSE).map((t) => `${t}${US_SUFFIX}`);

/** A US stock symbol like "AAPL.US". */
export function isUsSymbol(symbol: string | undefined): boolean {
  return !!symbol && /^[A-Z][A-Z0-9-]{0,9}\.US$/.test(symbol);
}

/** "AAPL.US" → "AAPL", the ticker Alpaca knows. */
export const usTicker = (symbol: string) => symbol.slice(0, -US_SUFFIX.length);
export const usSymbol = (ticker: string) => `${ticker}${US_SUFFIX}`;

// ---------- session (New York time, Monday to Friday) ----------

/** Minutes after midnight, New York time. */
export const US_OPEN = 9 * 60 + 30;
/** No new trades after this: too little time left before the close. */
export const US_LAST_ENTRY = 15 * 60 + 30;
/** Intraday positions are closed at this time. */
export const US_SQUARE_OFF = 15 * 60 + 50;
export const US_CLOSE = 16 * 60;

const nyFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The New York day, weekday and minutes after midnight (daylight saving included). */
export function nyParts(ms: number): { day: string; weekday: number; minutes: number } {
  const p = Object.fromEntries(nyFormat.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: WEEKDAYS[p.weekday] ?? 0, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** The US session is on (9:30 to 4:00 New York time on a weekday). Holidays aren't known here: no new candles come then. */
export function isUsOpen(nowMs: number = Date.now()): boolean {
  const { weekday, minutes } = nyParts(nowMs);
  return weekday >= 1 && weekday <= 5 && minutes >= US_OPEN && minutes < US_CLOSE;
}

/**
 * A US candle opening at `startMs` and lasting `frameMs` is (at least partly)
 * in the regular session. Alpaca's candles include pre-market and
 * after-hours trading, thin on the free IEX feed, which the scanner
 * doesn't trade and shouldn't learn from.
 */
export function inUsSession(startMs: number, frameMs: number): boolean {
  return isUsOpen(startMs + frameMs - 1);
}

/** New US trades are taken now (from the open until 3:30 New York time). */
export function usTakesEntries(nowMs: number = Date.now()): boolean {
  return isUsOpen(nowMs) && nyParts(nowMs).minutes < US_LAST_ENTRY;
}

/** A US position opened at `openTime` must be closed by now: 3:50 New York time or later, or a later day. */
export function usSquareOffDue(openTime: string, nowMs: number = Date.now()): boolean {
  const opened = Date.parse(openTime);
  if (!Number.isFinite(opened)) return false;
  const now = nyParts(nowMs);
  return now.day !== nyParts(opened).day || now.minutes >= US_SQUARE_OFF;
}

// ---------- costs (Alpaca, commission-free) ----------

/**
 * Regulatory fees per side, as a share of the trade (the SEC fee and FINRA's
 * trading activity fee apply to sells; rounded up and charged both ways).
 */
export const US_FEE_RATE_PER_SIDE = 0.00005;
export const US_ROUND_TRIP_RATE = 2 * US_FEE_RATE_PER_SIDE;
/** The least a "locked" stop must be past entry for a US stock (fees and a typical spread). */
export const US_BREAKEVEN_BUFFER = 0.001;
