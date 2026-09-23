import { MarketBar, RegimeType } from "../types";
import { SUPPORTED_SYMBOLS } from "./marketDataService";
import {
  decorateBarsWithIndicators,
  classifyRegime,
} from "./marketDataService";

export class LiveMarketStreamService {
  private reconnectTimer: NodeJS.Timeout | null = null;

  // Store the last 120 decorated bars per symbol
  private marketData: Map<string, MarketBar[]> = new Map();
  public dailyChanges = new Map<string, number>();

  // Higher-timeframe (1h) bars and the regime derived from them, used for
  // the multi-timeframe confluence check — sourced from CoinDCX's own real
  // candles API, refreshed periodically rather than on every tick since 1h
  // structure doesn't meaningfully change second to second.
  private higherTimeframeData: Map<string, MarketBar[]> = new Map();
  public macroRegimes: Map<string, RegimeType> = new Map();

  // Listeners for UI updates
  private globalListeners: Set<() => void> = new Set();

  public isReady = false;
  constructor() {}

  async initialize() {
    // Derived from SUPPORTED_SYMBOLS rather than a separate hardcoded list —
    // a hardcoded copy of this list has silently missed newly-added symbols
    // more than once now (XRP/INR twice, then reverted again when a file
    // got pasted out of order). One source of truth, permanently.
    const activeSymbols = SUPPORTED_SYMBOLS.map((s) => s.symbol);
    const cryptoSymbolsOnly = SUPPORTED_SYMBOLS.filter(
      (s) => s.assetClass === "crypto"
    ).map((s) => s.symbol);
    const equitySymbolsOnly = SUPPORTED_SYMBOLS.filter(
      (s) => s.assetClass === "equity"
    ).map((s) => s.symbol);

    console.log("Fetching initial live data for streaming...");
    try {
      // 1. Fetch current CoinDCX prices to base our initial chart
      const res = await fetch("/api/coindcx/ticker");
      const tickers = await res.json();

      const priceMap = new Map<string, number>();
      tickers.forEach((t: any) => {
        let sym = t.market.replace("INR", "/INR");
        if (t.market.endsWith("USDT")) sym = t.market.replace("USDT", "/USDT");
        if (activeSymbols.includes(sym)) {
          priceMap.set(sym, parseFloat(t.last_price));
        }
      });

      for (const sym of activeSymbols) {
        // Fall back to the hardcoded config basePrice if CoinDCX fetch fails for this symbol
        const configBasePrice =
          SUPPORTED_SYMBOLS.find((s) => s.symbol === sym)?.basePrice || 100;
        const currentLivePrice = priceMap.get(sym) || configBasePrice;

        // 2. Generate a realistic recent 120m history leading up to the exact live price
        const rawBars: MarketBar[] = [];
        let runningPrice = currentLivePrice * 0.995; // start slightly lower 2 hours ago

        const now = Date.now();
        for (let i = 120; i >= 0; i--) {
          const tMs = now - i * 60000;
          const volatility = currentLivePrice * 0.001;
          const shift = (Math.random() - 0.45) * volatility;
          if (i === 0) runningPrice = currentLivePrice; // force last bar to equal exactly live price
          else runningPrice += shift;

          rawBars.push({
            time: new Date(tMs).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
            timestampMs: tMs,
            open: runningPrice - Math.random() * volatility * 0.5,
            close: runningPrice,
            high: runningPrice + Math.random() * volatility,
            low: runningPrice - Math.random() * volatility,
            volume: Math.random() * 5 + 1,
          });
        }
        this.marketData.set(sym, decorateBarsWithIndicators(rawBars));
      }
    } catch (e) {
      console.error("Failed to fetch initial CoinDCX data", e);
    }

    this.isReady = true;
    this.notifyListeners();
    this.connectWs(activeSymbols);

    // Higher-timeframe data isn't tick-driven — fetch it once now, then on
    // a slow interval. 1h candles don't need refreshing every few seconds.
    // CoinDCX's candles endpoint only covers crypto pairs, and Zerodha's
    // historical-candles endpoint only works once logged in — each asset
    // class fetches its higher-timeframe view from its own real source.
    this.refreshHigherTimeframeData(cryptoSymbolsOnly, "crypto");
    this.refreshHigherTimeframeData(equitySymbolsOnly, "equity");

    setInterval(
      () => this.refreshHigherTimeframeData(cryptoSymbolsOnly, "crypto"),
      5 * 60 * 1000
    );
    setInterval(
      () => this.refreshHigherTimeframeData(equitySymbolsOnly, "equity"),
      5 * 60 * 1000
    );
  }

  /**
   * Fetches real 1h candles from CoinDCX (via the server proxy) for each
   * symbol, decorates them with the same indicators used elsewhere, and
   * derives a regime from them with the same classifyRegime() used for the
   * intraday view. This is what personaEngine's multi-timeframe alignment
   * check reads — grounded in CoinDCX's own real historical data, not the
   * synthetic backfill the 5m bars start from.
   */
  private async refreshHigherTimeframeData(
    symbols: string[],
    assetClass: "crypto" | "equity"
  ) {
    for (const sym of symbols) {
      try {
        let res: Response;
        if (assetClass === "crypto") {
          const base = sym.split("/")[0];
          res = await fetch(
            `/api/coindcx/candles?symbol=${base}&interval=1h&limit=100`
          );
        } else {
          // Zerodha's historical-candles endpoint needs an active login —
          // a 401 here just means "not connected yet", not a real failure.
          res = await fetch(
            `/api/zerodha/candles?symbol=${sym}&interval=60minute`
          );
          if (res.status === 401) {
            continue;
          }
        }

        if (!res.ok) {
          console.warn(
            `[HigherTimeframe] ${sym}: candles fetch failed (${res.status})`
          );
          continue;
        }

        const raw = await res.json();
        if (!Array.isArray(raw) || raw.length === 0) {
          console.warn(
            `[HigherTimeframe] ${sym}: empty/invalid candle response`
          );
          continue;
        }

        let bars: MarketBar[];
        if (assetClass === "crypto") {
          // CoinDCX returns candles newest-first; indicator math needs oldest-first.
          const ascending = [...raw].reverse();
          bars = ascending.map((c: any) => ({
            time: new Date(c.time).toISOString(),
            timestampMs: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          }));
        } else {
          // Zerodha's getHistoricalData already returns oldest-first.
          bars = raw.map((c: any) => ({
            time: new Date(c.date).toISOString(),
            timestampMs: new Date(c.date).getTime(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          }));
        }

        const decorated = decorateBarsWithIndicators(bars);
        this.higherTimeframeData.set(sym, decorated);
        this.macroRegimes.set(sym, classifyRegime(decorated));
      } catch (err) {
        console.warn(`[HigherTimeframe] ${sym}: fetch error`, err);
      }
    }
    this.notifyListeners();
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

  private ws: WebSocket | null = null;
  private connectWs(symbols: string[]) {
    if (this.ws) {
      this.ws.close();
    }

    // Connect to our Node.js backend relay which has an unfiltered, high-frequency connection to CoinDCX
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("Connected to Backend Ticker Relay");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "TICK" && msg.data) {
          Object.keys(msg.data).forEach((symbolInternal) => {
            const price = parseFloat(msg.data[symbolInternal]);
            if (msg.is24h) {
              // Update 24h map if this is a ticker event
              this.dailyChanges.set(symbolInternal, price);
            } else {
              // This is a trade event, update the bars
              if (!this.marketData.has(symbolInternal)) return;
              const bars = this.marketData.get(symbolInternal)!;
              if (bars.length === 0) return;

              const lastBar = bars[bars.length - 1];
              const tradeTime = Date.now();
              const isNewMinute =
                tradeTime - (lastBar.timestampMs || 0) > 60000;

              if (isNewMinute) {
                const newBar = {
                  time: new Date(tradeTime).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                  timestampMs: tradeTime,
                  open: price,
                  high: price,
                  low: price,
                  close: price,
                  volume: 0,
                };
                bars.push(newBar);
                if (bars.length > 120) bars.shift();
              } else {
                lastBar.close = price;
                if (price > lastBar.high) lastBar.high = price;
                if (price < lastBar.low) lastBar.low = price;
                // Note: volume aggregation omitted for brevity in relay
              }

              this.marketData.set(
                symbolInternal,
                decorateBarsWithIndicators(bars)
              );
            }
          });
          this.notifyListeners();
        }
      } catch (err) {}
    };

    this.ws.onerror = (err) => {
      console.warn("Backend WS Stream Error:", err);
    };

    this.ws.onclose = () => {
      setTimeout(() => this.connectWs(symbols), 3000);
    };
  }

  getBars(symbol: string): MarketBar[] | null {
    return this.marketData.get(symbol) || null;
  }

  getActiveSymbols(): string[] {
    return Array.from(this.marketData.keys());
  }

  subscribe(callback: () => void) {
    this.globalListeners.add(callback);
    return () => this.globalListeners.delete(callback);
  }

  private notifyListeners() {
    this.globalListeners.forEach((cb) => cb());
  }
}

export const liveMarketStream = new LiveMarketStreamService();
