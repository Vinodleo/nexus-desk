const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const oldImports = `import { KiteConnect } from 'kiteconnect';`;
const newImports = `import { KiteConnect, KiteTicker } from 'kiteconnect';`;
code = code.replace(oldImports, newImports);

// Need to inject globalWss
code = code.replace(
  'let kiteInstance: any = null;',
  'let kiteInstance: any = null;\nlet kiteTickerInstance: any = null;\nlet globalWss: WebSocketServer | null = null;'
);

const zerodhaTickerLogic = `
    // Set the access token in the instance for future API calls (orders, positions)
    kiteInstance.setAccessToken(zerodhaAccessToken);

    // Initialize Kite Ticker for live Indian Equity data
    if (kiteTickerInstance) {
      kiteTickerInstance.disconnect();
    }
    
    // Use the api_key and newly minted access_token
    kiteTickerInstance = new KiteTicker({
      api_key: kiteInstance.api_key,
      access_token: zerodhaAccessToken
    });

    // Hardcode some known NSE Instrument Tokens for the MVP symbols
    const instrumentMap: Record<number, string> = {
      341249: "HDFCBANK",
      738561: "RELIANCE",
      2953217: "TCS",
      779521: "SBIN"
    };

    kiteTickerInstance.on("ticks", (ticks: any[]) => {
      if (!globalWss) return;
      const updates: Record<string, number> = {};
      
      ticks.forEach(tick => {
        const symbol = instrumentMap[tick.instrument_token];
        if (symbol && tick.last_price) {
          updates[symbol] = tick.last_price;
        }
      });
      
      if (Object.keys(updates).length > 0) {
        // Broadcast to all connected clients
        globalWss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "TICK", data: updates }));
          }
        });
      }
    });

    kiteTickerInstance.on("connect", () => {
      console.log("Connected to Zerodha Kite Ticker Stream");
      const tokens = Object.keys(instrumentMap).map(Number);
      kiteTickerInstance.subscribe(tokens);
      kiteTickerInstance.setMode(kiteTickerInstance.modeFull, tokens);
    });

    kiteTickerInstance.on("error", (e: any) => console.error("Kite Ticker Error:", e));
    kiteTickerInstance.on("close", () => console.log("Kite Ticker Closed"));
    
    kiteTickerInstance.connect();
`;

code = code.replace(
  '// Set the access token in the instance for future API calls (orders, positions)\n    kiteInstance.setAccessToken(zerodhaAccessToken);',
  zerodhaTickerLogic
);

// Capture globalWss in startServer
code = code.replace(
  'const wss = new WebSocketServer({ server });',
  'const wss = new WebSocketServer({ server });\n  globalWss = wss;'
);

fs.writeFileSync('server.ts', code);
