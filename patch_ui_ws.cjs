const fs = require('fs');
let uiContent = fs.readFileSync('src/services/liveMarketStreamService.ts', 'utf-8');

const newConnectWs = `
  private ws: WebSocket | null = null;
  
  private connectWs(symbols: string[]) {
    if (this.ws) {
      this.ws.close();
    }
    
    // Connect to our Node.js backend relay which has an unfiltered, high-frequency connection to CoinDCX
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = \`\${protocol}//\${window.location.host}\`;
    
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
`;

const connectRegex = /private socket: Socket \| null = null;[\s\S]*?private connectWs\(symbols: string\[\]\) \{[\s\S]*?\n  \}/;
uiContent = uiContent.replace(connectRegex, newConnectWs);
// In case the socket was removed or different structure:
if (!uiContent.includes("private ws: WebSocket")) {
   // Fallback regex if previous didn't match
   const connectRegex2 = /private connectWs\(symbols: string\[\]\) \{[\s\S]*?\n  \}/;
   uiContent = uiContent.replace(connectRegex2, newConnectWs);
}

// Clean up socket.io import
uiContent = uiContent.replace('import { io, Socket } from "socket.io-client";', '');

fs.writeFileSync('src/services/liveMarketStreamService.ts', uiContent);
console.log("Patched UI WS to Backend Relay");
