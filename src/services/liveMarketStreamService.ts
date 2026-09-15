import { MarketBar } from "../types";
import { SUPPORTED_SYMBOLS } from "./marketDataService";
import { fetchRealHistoricalCandles } from "./realDataBacktestService";
import { decorateBarsWithIndicators } from "./marketDataService";

export class LiveMarketStreamService {
  private ws: EventSource | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  
  // Store the last 120 decorated bars per symbol
  private marketData: Map<string, MarketBar[]> = new Map();
  // Listeners for UI updates
  private globalListeners: Set<() => void> = new Set();
  
  public isReady = false;

  constructor() {}

  async initialize() {
    const activeSymbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "AVAX/USDT", "NEAR/USDT"];
    
    console.log("Fetching initial live data for streaming...");
    for (const sym of activeSymbols) {
      const cleanSym = sym.replace("/", "");
      try {
        const hist = await fetchRealHistoricalCandles(cleanSym, "1m", 120, "BINANCE");
        if (hist && hist.length > 0) {
          const rawBars: MarketBar[] = hist.map(h => ({
            time: new Date(h.timestamp || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            timestampMs: h.timestamp || Date.now(),
            open: h.open,
            high: h.high,
            low: h.low,
            close: h.close,
            volume: h.volume
          }));
          this.marketData.set(sym, decorateBarsWithIndicators(rawBars));
        }
      } catch (e) {
        console.error("Failed to fetch initial data for", sym, e);
      }
    }
    
    this.isReady = true;
    this.notifyListeners();
    this.connectWs(activeSymbols);
  }

    private connectWs(symbols: string[]) {
    if (this.ws) this.ws.close();
    
    const streams = symbols.map(s => `${s.replace("/", "").toLowerCase()}@kline_1m`).join('/');
    
    // Connect via Server-Sent Events (SSE) to bypass strict proxy WebSocket upgrades and auth hurdles
    const host = window.location.host;
    const url = `/api/stream/binance?streams=${streams}`;
    
    this.ws = new EventSource(url);
    
    this.ws.onopen = () => {
      console.log("Connected to local Binance SSE proxy:", url);
    };

    this.ws.onmessage = (event) => {
      try {
        const rawPayload = JSON.parse(event.data);
        const payload = rawPayload.data;
        if (!payload) return;
        
        if (payload.e === "kline") {
          const k = payload.k;
          let symbolInternal = payload.s;
          if (symbolInternal.endsWith("USDT")) symbolInternal = symbolInternal.replace("USDT", "/USDT");
          
          if (!this.marketData.has(symbolInternal)) return;

          const bars = this.marketData.get(symbolInternal)!;
          const lastBar = bars[bars.length - 1];
          
          const updatedRaw: MarketBar = {
            time: new Date(k.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            timestampMs: k.t,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
          };

          if (lastBar.timestampMs === k.t) {
            // Update current forming bar
            bars[bars.length - 1] = updatedRaw;
          } else {
            // New bar
            bars.push(updatedRaw);
            if (bars.length > 120) bars.shift();
          }

          // Redecorate the array to update indicators
          this.marketData.set(symbolInternal, decorateBarsWithIndicators(bars));
          this.notifyListeners();
        }
      } catch (err) {
        console.error("Error parsing SSE message:", err);
      }
    };

    this.ws.onerror = (err) => {
      // EventSource handles reconnection natively. Logging standard reconnects as errors 
      // triggers the global error tracker unnecessarily.
      if (this.ws?.readyState === EventSource.CONNECTING) {
        console.log("Binance SSE stream reconnecting...");
      } else if (this.ws?.readyState === EventSource.CLOSED) {
        console.warn("Binance SSE connection closed. Reconnecting manually in 5s...");
        this.reconnectTimer = setTimeout(() => this.connectWs(symbols), 5000);
      }
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
    this.globalListeners.forEach(cb => cb());
  }
}

export const liveMarketStream = new LiveMarketStreamService();
