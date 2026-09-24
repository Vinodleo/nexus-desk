import { MarketBar, RegimeType } from "../types";
import { SUPPORTED_SYMBOLS, decorateBarsWithIndicators, classifyRegime, isCryptoInrSymbol } from "./marketDataService";
import { DEFAULT_COINS, type CoinUniverse } from "../shared/coinUniverse";
import { apiFetch, authenticateSocket } from "./apiClient";
import { loadMarketRules } from "./marketRulesStore";

// Market data for the scanner and the price displays.
//
// Signals are computed from CLOSED 5-minute candles fetched from CoinDCX, with
// real volume, and refreshed just after each candle closes. An unfinished
// candle is never used, so a setup can't appear and vanish within a minute.
// Live ticks only update the last traded price shown on screen and used to
// price entries. 1-hour candles give the higher-timeframe trend.

export const SIGNAL_INTERVAL = "5m";
export const SIGNAL_INTERVAL_MS = 5 * 60 * 1000;
/** ~25 hours of 5-minute candles: enough for EMA-200 and the 14-bar ADX/ATR. */
const SIGNAL_CANDLES = 300;
/** After the first load, fetch only this many recent candles and merge them in. */
const RECENT_CANDLES = 24;
/** Candle requests to CoinDCX at once. */
const FETCH_CONCURRENCY = 6;
const UNIVERSE_REFRESH_MS = 60 * 60 * 1000;
/** Wait this long after a candle's close before fetching it, so CoinDCX has finalised it. */
const CLOSE_GRACE_MS = 8000;
/** Fewer closed candles than this and a symbol isn't scanned. */
export const MIN_SIGNAL_BARS = 60;

/** Candle open time in ms from a number (ms or seconds), numeric string or ISO date. */
function toMs(t: unknown): number {
  const n = typeof t === "number" ? t : typeof t === "string" && t.trim() !== "" && !isNaN(Number(t)) ? Number(t) : NaN;
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  if (typeof t === "string") return Date.parse(t);
  return NaN;
}

/**
 * One candle from CoinDCX, as an object ({ time, open, high, low, close,
 * volume }) or an array ([time, open, high, low, close, volume]).
 */
function readCandle(c: unknown): MarketBar | null {
  let t: unknown, o: unknown, h: unknown, l: unknown, cl: unknown, v: unknown;
  if (Array.isArray(c)) [t, o, h, l, cl, v] = c;
  else if (c && typeof c === "object") {
    const r = c as Record<string, unknown>;
    [t, o, h, l, cl, v] = [r.time ?? r.t ?? r.timestamp, r.open ?? r.o, r.high ?? r.h, r.low ?? r.l, r.close ?? r.c, r.volume ?? r.v];
  } else return null;
  const timestampMs = toMs(t);
  const bar = {
    time: "",
    timestampMs,
    open: Number(o),
    high: Number(h),
    low: Number(l),
    close: Number(cl),
    volume: Number(v) || 0,
  };
  if (!Number.isFinite(timestampMs) || !(bar.close > 0) || !(bar.high >= bar.low)) return null;
  bar.time = new Date(timestampMs).toISOString();
  return bar;
}

/**
 * CoinDCX candles (newest first, including the one still forming) to closed
 * bars, oldest first. A candle is closed once its open time plus the
 * interval has passed.
 */
export function toClosedBars(raw: unknown, intervalMs: number, nowMs: number): MarketBar[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(readCandle)
    .filter((b): b is MarketBar => b !== null && (b.timestampMs as number) + intervalMs <= nowMs)
    .sort((a, b) => (a.timestampMs as number) - (b.timestampMs as number));
}

/** When the next signal candle closes (plus the grace period), from `nowMs`. */
export function nextCandleFetchAt(nowMs: number, intervalMs = SIGNAL_INTERVAL_MS): number {
  return Math.floor(nowMs / intervalMs) * intervalMs + intervalMs + CLOSE_GRACE_MS;
}

/**
 * Adds freshly fetched candles to the ones already held: a fetched candle
 * replaces a held one with the same open time. Oldest first, at most `max`.
 */
export function mergeBars(held: MarketBar[], fresh: MarketBar[], max: number): MarketBar[] {
  const byTime = new Map<number, MarketBar>();
  for (const b of held) if (b.timestampMs !== undefined) byTime.set(b.timestampMs, b);
  for (const b of fresh) if (b.timestampMs !== undefined) byTime.set(b.timestampMs, b);
  return [...byTime.values()].sort((a, b) => (a.timestampMs as number) - (b.timestampMs as number)).slice(-max);
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

type CandleFetch = { bars: MarketBar[]; error?: string };

async function fetchClosedCandles(symbol: string, interval: string, intervalMs: number, limit: number): Promise<CandleFetch> {
  try {
    const base = symbol.split("/")[0];
    const res = await apiFetch(`/api/coindcx/candles?symbol=${base}&interval=${interval}&limit=${limit}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) return { bars: [], error: body?.error || `HTTP ${res.status}` };
    const bars = toClosedBars(body, intervalMs, Date.now());
    if (bars.length === 0) {
      const sample = JSON.stringify(Array.isArray(body) ? body[0] : body)?.slice(0, 120);
      return { bars, error: `No usable candles in CoinDCX's reply (${sample ?? "empty"})` };
    }
    return { bars };
  } catch (err: any) {
    return { bars: [], error: err?.message || "Couldn't reach the server" };
  }
}

/** Whether the scanner has real candles for a coin, and if not, why. */
export interface CandleStatus {
  symbol: string;
  bars: number;
  error?: string;
  checkedAt: number;
}

class LiveMarketStreamService {
  /** Closed 5-minute candles with indicators, per symbol. */
  private marketData: Map<string, MarketBar[]> = new Map();
  private candleStatus: Map<string, CandleStatus> = new Map();
  /** Last traded price from the live feed, per symbol. */
  private lastPrices: Map<string, number> = new Map();
  /** 24-hour change in %, from CoinDCX's ticker. */
  public dailyChanges = new Map<string, number>();

  private higherTimeframeData: Map<string, MarketBar[]> = new Map();
  public macroRegimes: Map<string, RegimeType> = new Map();

  private globalListeners: Set<() => void> = new Set();
  private candleListeners: Set<(symbols: string[]) => void> = new Set();
  private candleTimer: ReturnType<typeof setTimeout> | null = null;

  public isReady = false;

  /** The coins the scanner covers: CoinDCX's most traded INR coins, from the server. */
  private cryptoSymbols = DEFAULT_COINS.map((c) => `${c}/INR`);
  private equitySymbols = SUPPORTED_SYMBOLS.filter((s) => s.assetClass === "equity").map((s) => s.symbol);
  private universeUpdatedAt = 0;
  private universeIsFallback = true;

  async initialize() {
    await this.refreshUniverse();
    await Promise.all([this.refreshTicker(), loadMarketRules(), this.refreshSignalCandles()]);
    this.isReady = true;
    this.notifyListeners();
    this.connectWs();

    this.scheduleNextCandleFetch();
    setInterval(() => this.refreshTicker(), 60 * 1000);
    setInterval(() => void this.followUniverse(), UNIVERSE_REFRESH_MS);

    // 1-hour candles for the higher-timeframe trend; they change slowly.
    this.refreshHigherTimeframeData(this.cryptoSymbols, "crypto");
    this.refreshHigherTimeframeData(this.equitySymbols, "equity");
    setInterval(() => this.refreshHigherTimeframeData(this.cryptoSymbols, "crypto"), 5 * 60 * 1000);
    setInterval(() => this.refreshHigherTimeframeData(this.equitySymbols, "equity"), 5 * 60 * 1000);
  }

  /** Reads the coin list from the server. Returns the coins that are new to it. */
  private async refreshUniverse(): Promise<string[]> {
    try {
      const res = await apiFetch("/api/coindcx/universe");
      if (!res.ok) return [];
      const u = (await res.json()) as CoinUniverse;
      const symbols = Array.isArray(u?.coins) ? u.coins.map((c) => c?.symbol).filter((s): s is string => typeof s === "string" && isCryptoInrSymbol(s)) : [];
      if (symbols.length === 0) return [];
      const added = symbols.filter((s) => !this.cryptoSymbols.includes(s));
      const dropped = this.cryptoSymbols.filter((s) => !symbols.includes(s));
      this.cryptoSymbols = symbols;
      this.universeUpdatedAt = u.updatedAt ?? Date.now();
      this.universeIsFallback = Boolean(u.fallback);
      for (const s of dropped) {
        this.marketData.delete(s);
        this.candleStatus.delete(s);
        this.higherTimeframeData.delete(s);
        this.macroRegimes.delete(s);
      }
      return added;
    } catch (err) {
      console.warn("[MarketStream] coin list refresh failed", err);
      return [];
    }
  }

  /** Hourly: picks up the new coin list and loads candles for coins new to it. */
  private async followUniverse() {
    const added = await this.refreshUniverse();
    if (added.length === 0) return;
    await this.refreshSignalCandles(added);
    this.notifyListeners();
    await this.refreshHigherTimeframeData(added, "crypto");
  }

  /** Last prices and 24-hour changes from CoinDCX's ticker. */
  private async refreshTicker() {
    try {
      const res = await apiFetch("/api/coindcx/ticker");
      const tickers = await res.json();
      if (!Array.isArray(tickers)) return;
      for (const t of tickers as { market: string; last_price: string; change_24_hour?: string }[]) {
        if (typeof t?.market !== "string" || !t.market.endsWith("INR")) continue;
        const sym = t.market.replace(/INR$/, "/INR");
        const price = parseFloat(t.last_price);
        if (price > 0) this.lastPrices.set(sym, price);
        const change = parseFloat(t.change_24_hour ?? "");
        if (Number.isFinite(change)) this.dailyChanges.set(sym, change);
      }
      this.notifyListeners();
    } catch (err) {
      console.warn("[MarketStream] ticker refresh failed", err);
    }
  }

  /**
   * Fetches closed 5-minute candles for each crypto symbol: the full history
   * the first time, then only the latest few, merged into what's held.
   * Returns the symbols that got a new candle.
   */
  private async refreshSignalCandles(symbols: string[] = this.cryptoSymbols): Promise<string[]> {
    const updated: string[] = [];
    await forEachLimited(symbols, FETCH_CONCURRENCY, async (sym) => {
      const held = this.marketData.get(sym);
      const lastHeld = this.getLatestClosedCandleMs(sym);
      const recentOnly =
        !!held && held.length >= MIN_SIGNAL_BARS && lastHeld !== undefined && Date.now() - lastHeld < (RECENT_CANDLES - 4) * SIGNAL_INTERVAL_MS;
      let { bars, error } = await fetchClosedCandles(sym, SIGNAL_INTERVAL, SIGNAL_INTERVAL_MS, recentOnly ? RECENT_CANDLES : SIGNAL_CANDLES);
      if (bars.length === 0) {
        // One retry with a smaller request, in case the size was the problem.
        const retry = await fetchClosedCandles(sym, SIGNAL_INTERVAL, SIGNAL_INTERVAL_MS, 120);
        if (retry.bars.length > 0) ({ bars, error } = retry);
      }
      if (bars.length > 0 && recentOnly) bars = mergeBars(held!, bars, SIGNAL_CANDLES);
      this.candleStatus.set(sym, {
        symbol: sym,
        bars: bars.length || this.marketData.get(sym)?.length || 0,
        error,
        checkedAt: Date.now(),
      });
      if (bars.length === 0) {
        console.warn(`[MarketStream] ${sym}: ${error}`);
        return;
      }
      const prevLast = this.getLatestClosedCandleMs(sym);
      this.marketData.set(sym, decorateBarsWithIndicators(bars));
      if (!this.lastPrices.has(sym)) this.lastPrices.set(sym, bars[bars.length - 1].close);
      if (bars[bars.length - 1].timestampMs !== prevLast) updated.push(sym);
    });
    return updated;
  }

  private scheduleNextCandleFetch() {
    if (this.candleTimer) clearTimeout(this.candleTimer);
    const delay = Math.max(1000, nextCandleFetchAt(Date.now()) - Date.now());
    this.candleTimer = setTimeout(async () => {
      const updated = await this.refreshSignalCandles();
      this.notifyListeners();
      if (updated.length > 0) this.candleListeners.forEach((cb) => cb(updated));
      // A candle that wasn't published yet gets one quick retry.
      const pending = this.cryptoSymbols.filter((s) => !updated.includes(s));
      if (pending.length > 0) {
        setTimeout(async () => {
          const late = await this.refreshSignalCandles(pending);
          if (late.length > 0) {
            this.notifyListeners();
            this.candleListeners.forEach((cb) => cb(late));
          }
        }, 20000);
      }
      this.scheduleNextCandleFetch();
    }, delay);
  }

  /** 1-hour candles for the higher-timeframe trend check. */
  private async refreshHigherTimeframeData(symbols: string[], assetClass: "crypto" | "equity") {
    for (const sym of symbols) {
      try {
        let bars: MarketBar[] | null;
        if (assetClass === "crypto") {
          bars = (await fetchClosedCandles(sym, "1h", 60 * 60 * 1000, 100)).bars;
        } else {
          // Zerodha's historical-candles endpoint needs an active login —
          // a 401 just means "not connected yet", not a failure.
          const res = await apiFetch(`/api/zerodha/candles?symbol=${sym}&interval=60minute`);
          if (!res.ok) continue;
          const raw = await res.json();
          bars = Array.isArray(raw)
            ? raw.map((c: any) => ({
                time: new Date(c.date).toISOString(),
                timestampMs: new Date(c.date).getTime(),
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
              }))
            : null;
        }
        if (!bars || bars.length === 0) continue;
        const decorated = decorateBarsWithIndicators(bars);
        this.higherTimeframeData.set(sym, decorated);
        this.macroRegimes.set(sym, classifyRegime(decorated));
      } catch (err) {
        console.warn(`[HigherTimeframe] ${sym}: fetch error`, err);
      }
    }
    this.notifyListeners();
  }

  private ws: WebSocket | null = null;
  private connectWs() {
    if (this.ws) this.ws.close();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${protocol}//${window.location.host}`);
    const ws = this.ws;
    ws.onopen = () => authenticateSocket(ws);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type !== "TICK" || !msg.data) return;
        for (const sym of Object.keys(msg.data)) {
          const price = parseFloat(msg.data[sym]);
          if (price > 0) this.lastPrices.set(sym, price);
        }
        this.notifyListeners();
      } catch {}
    };
    ws.onerror = (err) => console.warn("Backend WS Stream Error:", err);
    ws.onclose = () => setTimeout(() => this.connectWs(), 3000);
  }

  /** Closed 5-minute candles with indicators, oldest first. */
  getBars(symbol: string): MarketBar[] | null {
    return this.marketData.get(symbol) || null;
  }

  /** Candle status for every crypto coin the scanner covers. */
  getCandleStatus(): CandleStatus[] {
    return this.cryptoSymbols.map(
      (sym) => this.candleStatus.get(sym) ?? { symbol: sym, bars: 0, checkedAt: 0, error: "Not loaded yet" }
    );
  }

  getLastPrice(symbol: string): number | undefined {
    return this.lastPrices.get(symbol);
  }

  /** Open time of the latest closed candle, or undefined if none yet. */
  getLatestClosedCandleMs(symbol: string): number | undefined {
    const bars = this.marketData.get(symbol);
    return bars && bars.length > 0 ? bars[bars.length - 1].timestampMs : undefined;
  }

  /** Symbols with a price or candles: the scanned coins, then stocks. */
  getActiveSymbols(): string[] {
    return [...this.cryptoSymbols, ...this.equitySymbols].filter((s) => this.marketData.has(s) || this.lastPrices.has(s));
  }

  /** The crypto coins the scanner covers, most traded first. */
  getCryptoSymbols(): string[] {
    return [...this.cryptoSymbols];
  }

  /** When the coin list was last picked, and whether it's the default list. */
  getUniverseInfo(): { count: number; updatedAt: number; fallback: boolean } {
    return { count: this.cryptoSymbols.length, updatedAt: this.universeUpdatedAt, fallback: this.universeIsFallback };
  }

  getHigherTimeframeBars(symbol: string): MarketBar[] | null {
    return this.higherTimeframeData.get(symbol) || null;
  }

  /** Neutral when no higher-timeframe data is available yet — the alignment
   * check treats "neutral" as "no opinion", never blocking a trade for lack
   * of data rather than failing closed on a slow/failed fetch. */
  getMacroRegime(symbol: string): RegimeType | "neutral" {
    return this.macroRegimes.get(symbol) || "neutral";
  }

  subscribe(callback: () => void) {
    this.globalListeners.add(callback);
    return () => {
      this.globalListeners.delete(callback);
    };
  }

  /** Called with the symbols that just got a newly closed signal candle. */
  onCandleClose(callback: (symbols: string[]) => void) {
    this.candleListeners.add(callback);
    return () => {
      this.candleListeners.delete(callback);
    };
  }

  private notifyListeners() {
    this.globalListeners.forEach((cb) => cb());
  }
}

export const liveMarketStream = new LiveMarketStreamService();
