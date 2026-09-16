
import { MarketBar } from "../types";
import { SUPPORTED_SYMBOLS } from "./marketDataService";
import { fetchRealHistoricalCandles } from "./realDataBacktestService";
import { decorateBarsWithIndicators } from "./marketDataService";

export class LiveMarketStreamService {
  
  private reconnectTimer: NodeJS.Timeout | null = null;
  
  // Store the last 120 decorated bars per symbol
  private marketData: Map<string, MarketBar[]> = new Map();
  public dailyChanges = new Map<string, number>();
  // Listeners for UI updates
  private globalListeners: Set<() => void> = new Set();
  
  public isReady = false;

  constructor() {}

  async initialize() {
    const activeSymbols = ["BTC/INR", "ETH/INR", "SOL/INR", "AVAX/INR", "NEAR/INR"];
    
    console.log("Fetching initial live data for streaming...");
    try {
      // 1. Fetch current CoinDCX prices to base our initial chart
      const res = await fetch('/api/coindcx/ticker');
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
        const currentLivePrice = priceMap.get(sym) || 7500000;
        
        // 2. Generate a realistic recent 120m history leading up to the exact live price
        const rawBars: MarketBar[] = [];
        let runningPrice = currentLivePrice * 0.995; // start slightly lower 2 hours ago
        const now = Date.now();
        
        for (let i = 120; i >= 0; i--) {
          const tMs = now - (i * 60000);
          const volatility = currentLivePrice * 0.001;
          const shift = (Math.random() - 0.45) * volatility;
          
          if (i === 0) runningPrice = currentLivePrice; // force last bar to equal exactly live price
          else runningPrice += shift;

          rawBars.push({
            time: new Date(tMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            timestampMs: tMs,
            open: runningPrice - (Math.random() * volatility * 0.5),
            close: runningPrice,
            high: runningPrice + (Math.random() * volatility),
            low: runningPrice - (Math.random() * volatility),
            volume: Math.random() * 5 + 1
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
  }

    
  
  private ws: WebSocket | null = null;
  
  private connectWs(symbols: string[]) {
    if (this.ws) {
      this.ws.close();
    }
    
    // Connect to our Node.js backend relay which has an unfiltered, high-frequency connection to CoinDCX
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("Connected to Backend Ticker Relay");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'TICK' && msg.data) {
          
          Object.keys(msg.data).forEach(symbolInternal => {
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
               
               const isNewMinute = (tradeTime - lastBar.timestampMs) > 60000;
               
               if (isNewMinute) {
                 const newBar = {
                   time: new Date(tradeTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
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
               
               this.marketData.set(symbolInternal, decorateBarsWithIndicators(bars));
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
    this.globalListeners.forEach(cb => cb());
  }
}

export const liveMarketStream = new LiveMarketStreamService();
