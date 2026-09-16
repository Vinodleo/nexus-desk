const fs = require('fs');
let uiContent = fs.readFileSync('src/services/liveMarketStreamService.ts', 'utf-8');

// Replace the WebSocket with socket.io-client
if (!uiContent.includes("import { io, Socket }")) {
  uiContent = 'import { io, Socket } from "socket.io-client";\n' + uiContent;
}

// Replace the activeSymbols definition to use INR
uiContent = uiContent.replace(
  'const activeSymbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "AVAX/USDT", "NEAR/USDT"];',
  'const activeSymbols = ["BTC/INR", "ETH/INR", "SOL/INR", "AVAX/INR", "NEAR/INR"];'
);

// We should replace connectWs with Socket.io version
const newConnectWs = `
  private socket: Socket | null = null;
  
  private connectWs(symbols: string[]) {
    if (this.socket) {
      this.socket.disconnect();
    }
    
    // Connect directly to CoinDCX High-Frequency Socket.IO stream
    this.socket = io("wss://stream.coindcx.com", {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });

    this.socket.on("connect", () => {
      console.log("Connected to CoinDCX High-Frequency Spot Stream");
      
      // Join channels for all symbols (e.g., BTC/INR -> I-BTC_INR)
      symbols.forEach(sym => {
        const parts = sym.split("/");
        if (parts.length === 2 && parts[1] === "INR") {
           const channelName = \`I-\${parts[0]}_INR\`;
           this.socket?.emit('join', { channelName });
        }
      });
    });

    this.socket.on("new-trade", (rawEvent: any) => {
      try {
        const payload = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : rawEvent;
        const data = typeof payload.data === 'string' ? JSON.parse(payload.data) : payload.data;
        
        if (!data || !data.s || !data.p) return;
        
        // Map BTCINR back to BTC/INR
        const symbolInternal = data.s.replace('INR', '/INR');
        
        if (!this.marketData.has(symbolInternal)) return;
        
        const bars = this.marketData.get(symbolInternal)!;
        if (bars.length === 0) return;
        
        const lastBar = bars[bars.length - 1];
        const price = parseFloat(data.p);
        const volume = parseFloat(data.q || "0");
        const tradeTime = data.T || Date.now();
        
        // Update the current 1m bar
        // We aggregate the ticks into the last bar
        const isNewMinute = (tradeTime - lastBar.timestampMs) > 60000;
        
        if (isNewMinute) {
          const newBar = {
            time: new Date(tradeTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            timestampMs: tradeTime,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: volume,
          };
          bars.push(newBar);
          if (bars.length > 120) bars.shift();
        } else {
          lastBar.close = price;
          if (price > lastBar.high) lastBar.high = price;
          if (price < lastBar.low) lastBar.low = price;
          lastBar.volume += volume;
        }
        
        this.marketData.set(symbolInternal, decorateBarsWithIndicators(bars));
        this.notifyListeners();
        
      } catch (err) {}
    });

    this.socket.on("connect_error", (err: any) => {
      console.warn("CoinDCX Stream Error:", err.message);
    });
  }
`;

// Remove the old connectWs and replace it
const connectRegex = /private connectWs\(symbols: string\[\]\) \{[\s\S]*?\n  \}/;
uiContent = uiContent.replace(connectRegex, newConnectWs);

// Also remove this.ws property if it exists
uiContent = uiContent.replace('private ws: WebSocket | any = null;', '');
uiContent = uiContent.replace('if (this.ws) this.ws.close();', '');

fs.writeFileSync('src/services/liveMarketStreamService.ts', uiContent);
console.log("Patched UI");
