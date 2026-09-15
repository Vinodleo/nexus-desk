const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const wsImport = `
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
`;

code = code.replace(
  'import { createServer as createViteServer } from "vite";',
  'import { createServer as createViteServer } from "vite";\n' + wsImport
);

const startServerReplacement = `
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(\`Self-Learning Trading Bot v2.0 Server running on port \${PORT}\`);
  });

  // Attach WebSocket server for live Binance Ticker data
  const wss = new WebSocketServer({ server });
  
  // Cache the latest prices
  const latestPrices: Record<string, number> = {};

  // Connect to Binance live ticker stream
  const binanceWs = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');
  
  binanceWs.on('message', (data: WebSocket.RawData) => {
    try {
      const parsed = JSON.parse(data.toString());
      parsed.forEach((tick: any) => {
        // e.g. "BTCUSDT" -> 64000.5
        latestPrices[tick.s] = parseFloat(tick.c);
      });
      
      // Broadcast to our connected clients
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          // Send a curated list of top pairs to keep client parsing light
          client.send(JSON.stringify({
            type: 'TICK',
            data: {
              'BTC/USDT': latestPrices['BTCUSDT'],
              'ETH/USDT': latestPrices['ETHUSDT'],
              'SOL/USDT': latestPrices['SOLUSDT'],
              'AVAX/USDT': latestPrices['AVAXUSDT']
            }
          }));
        }
      });
    } catch (e) {
      console.error("Error parsing binance ws", e);
    }
  });

  binanceWs.on('error', (err: any) => {
    console.error('Binance WS Error:', err);
  });
`;

code = code.replace(
  /const server = app\.listen[\s\S]*\}\);/m,
  startServerReplacement
);

fs.writeFileSync('server.ts', code);
