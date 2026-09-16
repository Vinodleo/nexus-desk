const fs = require('fs');
let uiContent = fs.readFileSync('src/services/liveMarketStreamService.ts', 'utf-8');

const newWsConnect = `
  private connectWs(symbols: string[]) {
    // We use Binance Futures Public WebSocket for ultra-low latency sub-second updates.
    // CoinDCX Global Futures shares the exact same liquidity pool and price feed as Binance.
    const streams = symbols
      .map(sym => sym.replace('/', '').toLowerCase() + '@kline_1m')
      .join('/');
    
    // Connect directly from client to Binance, no server proxy needed = 0 latency overhead
    const url = \`wss://fstream.binance.com/stream?streams=\${streams}\`;
    
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log("Connected to High-Frequency Global Market Stream");
    };

    this.ws.onmessage = (event) => {
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
            // Update current forming bar
            bars[bars.length - 1] = updatedRaw;
          } else {
            // New bar
            bars.push(updatedRaw);
            if (bars.length > 120) bars.shift();
          }
          
          this.marketData.set(symbolInternal, decorateBarsWithIndicators(bars));
          this.notifyListeners();
        }
      } catch (err) {
        // silent parse error
      }
    };

    this.ws.onerror = (err) => {
      console.error("HF Stream Error:", err);
    };

    this.ws.onclose = () => {
      console.log("HF Stream disconnected. Reconnecting in 3s...");
      this.reconnectTimer = setTimeout(() => this.connectWs(symbols), 3000);
    };
  }
`;

// Replace the connectWs method
const startIdx = uiContent.indexOf('  private connectWs(symbols: string[]) {');
const endIdx = uiContent.indexOf('  destroy() {');
if (startIdx !== -1 && endIdx !== -1) {
   uiContent = uiContent.substring(0, startIdx) + newWsConnect + "\n" + uiContent.substring(endIdx);
   fs.writeFileSync('src/services/liveMarketStreamService.ts', uiContent);
   console.log("Patched WS connection");
} else {
   console.log("Could not find connectWs");
}

