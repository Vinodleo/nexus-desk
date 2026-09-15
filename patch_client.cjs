const fs = require('fs');
let code = fs.readFileSync('src/services/liveMarketStreamService.ts', 'utf-8');

// Replace WebSocket with EventSource for the property type
code = code.replace('private ws: WebSocket | null = null;', 'private ws: EventSource | null = null;');

const newConnectWs = `  private connectWs(symbols: string[]) {
    if (this.ws) this.ws.close();
    
    const streams = symbols.map(s => \`\${s.replace("/", "").toLowerCase()}@kline_1m\`).join('/');
    
    // Connect via Server-Sent Events (SSE) to bypass strict proxy WebSocket upgrades and auth hurdles
    const host = window.location.host;
    const url = \`/api/stream/binance?streams=\${streams}\`;
    
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
      console.error("Binance SSE Error:", err);
      if (this.ws?.readyState === EventSource.CLOSED) {
        console.log("Binance SSE Closed. Reconnecting in 5s...");
        this.reconnectTimer = setTimeout(() => this.connectWs(symbols), 5000);
      }
    };
  }`;

// Replace the entire private connectWs(...) method
const startIdx = code.indexOf('private connectWs(');
const endIdx = code.indexOf('getBars(symbol: string): MarketBar[] | null {');

code = code.substring(0, startIdx) + newConnectWs + '\n\n  ' + code.substring(endIdx);

fs.writeFileSync('src/services/liveMarketStreamService.ts', code);
