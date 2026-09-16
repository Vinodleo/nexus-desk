const fs = require('fs');
let uiContent = fs.readFileSync('src/services/liveMarketStreamService.ts', 'utf-8');

const newWsConnect = `  private connectWs(symbols: string[]) {
    if (this.ws) this.ws.close();
    
    // We connect DIRECTLY to Binance Futures high-frequency websocket for zero-latency sub-second ticks.
    // This perfectly mirrors CoinDCX's USDT liquidity pool.
    const streams = symbols.map(s => \`\${s.replace("/", "").toLowerCase()}@kline_1m\`).join('/');
    const url = \`wss://fstream.binance.com/stream?streams=\${streams}\`;
    
    // Force TypeScript to treat this as WebSocket since it was previously EventSource
    this.ws = new WebSocket(url) as any;
    
    this.ws.onopen = () => {
      console.log("Connected to High-Frequency Direct Stream:", url);
    };

    this.ws.onmessage = (event: any) => {
      try {
        const rawPayload = JSON.parse(event.data);
        if (!rawPayload.data) return;
        
        const payload = rawPayload.data;
        if (payload.e === "kline") {
          const k = payload.k;
          let symbolInternal = payload.s;
          if (symbolInternal.endsWith("USDT")) symbolInternal = symbolInternal.replace("USDT", "/USDT");
          
          if (!this.marketData.has(symbolInternal)) return;

          const bars = this.marketData.get(symbolInternal)!;
          if (bars.length === 0) return;
          const lastBar = bars[bars.length - 1];
          
          const updatedRaw = {
            time: new Date(k.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            timestampMs: k.t,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
          };

          if (lastBar.timestampMs === k.t) {
            bars[bars.length - 1] = updatedRaw;
          } else {
            bars.push(updatedRaw);
            if (bars.length > 120) bars.shift();
          }
          
          this.marketData.set(symbolInternal, decorateBarsWithIndicators(bars));
          this.notifyListeners();
        }
      } catch (err) {}
    };

    this.ws.onerror = (err: any) => {
      console.warn("Stream error", err);
    };
    
    this.ws.onclose = () => {
      console.log("Stream closed. Reconnecting in 3s...");
      this.reconnectTimer = setTimeout(() => this.connectWs(symbols), 3000);
    };
  }`;

// Replace the connectWs method
const startIdx = uiContent.indexOf('  private connectWs(symbols: string[]) {');
const endIdx = uiContent.indexOf('  getBars(symbol: string): MarketBar[] | null {');
if (startIdx !== -1 && endIdx !== -1) {
   uiContent = uiContent.substring(0, startIdx) + newWsConnect + "\n" + uiContent.substring(endIdx);
   
   // Also need to change EventSource definition to WebSocket or any
   uiContent = uiContent.replace('private ws: EventSource | null = null;', 'private ws: WebSocket | any = null;');
   
   fs.writeFileSync('src/services/liveMarketStreamService.ts', uiContent);
   console.log("Patched WS connection");
} else {
   console.log("Could not find connectWs bounds");
}

