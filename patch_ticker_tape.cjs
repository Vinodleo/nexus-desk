const fs = require('fs');

// The ticker tape is driven by the backend wss stream currently. 
// We can modify App.tsx to use liveMarketStreamService for the ticker tape too, or modify server.ts to poll faster,
// or connect server to wss://fstream.binance.com/stream for the top ticker tape.

let serverContent = fs.readFileSync('server.ts', 'utf-8');

const newTickerStream = `
  // We use Binance Futures Public WebSocket for ultra-low latency sub-second updates for the ticker tape.
  // CoinDCX Global Futures shares this liquidity.
  const WebSocket = require('ws');
  
  const binanceWs = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
  
  binanceWs.on('message', (data) => {
    try {
      const tickers = JSON.parse(data);
      const payload = {};
      let updated = false;
      
      tickers.forEach(t => {
        if (['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AVAXUSDT', 'NEARUSDT'].includes(t.s)) {
          payload[t.s.replace('USDT', '/USDT')] = parseFloat(t.c);
          updated = true;
        }
      });
      
      if (updated) {
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'TICK', data: payload }));
          }
        });
      }
    } catch (err) {}
  });
  
  binanceWs.on('error', () => {});
`;

// Replace the polling logic
const startIdx = serverContent.indexOf('  setInterval(async () => {');
const endIdx = serverContent.indexOf('  wss.on("connection", (ws) => {');

if (startIdx !== -1 && endIdx !== -1) {
  serverContent = serverContent.substring(0, startIdx) + newTickerStream + "\n" + serverContent.substring(endIdx);
  fs.writeFileSync('server.ts', serverContent);
  console.log("Patched server ticker stream");
}
