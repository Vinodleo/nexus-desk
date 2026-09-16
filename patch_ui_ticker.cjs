const fs = require('fs');
let uiContent = fs.readFileSync('src/services/liveMarketStreamService.ts', 'utf-8');

// We need to store 24h change for the UI
// Add 24h map to the class
if (!uiContent.includes("public dailyChanges = new Map<string, number>();")) {
  uiContent = uiContent.replace(
    'private marketData: Map<string, MarketBar[]> = new Map();',
    'private marketData: Map<string, MarketBar[]> = new Map();\n  public dailyChanges = new Map<string, number>();'
  );
}

// In the connectWs, join coindcx
uiContent = uiContent.replace(
  'symbols.forEach(sym => {',
  'this.socket?.emit("join", { channelName: "coindcx" });\n      symbols.forEach(sym => {'
);

// Add the ticker listener
const tickerListener = `
    this.socket.on("ticker", (rawEvent: any) => {
      try {
        const payload = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : rawEvent;
        const data = typeof payload.data === 'string' ? JSON.parse(payload.data) : payload.data;
        if (!data || !data.s || typeof data.c !== 'number') return;
        
        const symbolInternal = data.s.replace('INR', '/INR');
        if (this.marketData.has(symbolInternal)) {
          this.dailyChanges.set(symbolInternal, parseFloat(data.c));
          this.notifyListeners();
        }
      } catch(e) {}
    });
`;

if (!uiContent.includes('this.socket.on("ticker"')) {
  uiContent = uiContent.replace(
    'this.socket.on("new-trade",',
    tickerListener + '\n    this.socket.on("new-trade",'
  );
}

fs.writeFileSync('src/services/liveMarketStreamService.ts', uiContent);
