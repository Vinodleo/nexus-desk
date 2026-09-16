const fs = require('fs');
let serverContent = fs.readFileSync('server.ts', 'utf-8');

// Change activeMarkets back to INR
serverContent = serverContent.replace(
  "const activeMarkets = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AVAXUSDT', 'NEARUSDT'];",
  "const activeMarkets = ['BTCINR', 'ETHINR', 'SOLINR', 'AVAXINR', 'NEARINR'];"
);

// We need to replace the Binance WS with CoinDCX polling
const oldHFStreamRegex = /\/\/ High-Frequency Binance Ticker Stream[\s\S]*?binanceWs\.on\('error', \(\) => \{\}\);/m;

const newPollStream = `
  // High-Frequency CoinDCX Polling for Ticker Tape
  setInterval(async () => {
    try {
      const response = await fetch('https://public.coindcx.com/exchange/ticker');
      const data = await response.json();
      
      const payload: Record<string, number> = {};
      let updated = false;
      
      data.forEach((ticker: any) => {
        if (['BTCINR', 'ETHINR', 'SOLINR', 'AVAXINR', 'NEARINR'].includes(ticker.market)) {
          payload[ticker.market.replace('INR', '/INR')] = parseFloat(ticker.last_price);
          updated = true;
        }
      });

      if (updated) {
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'TICK',
              data: payload
            }));
          }
        });
      }
    } catch (e: any) {
      // silent fail on tape poll
    }
  }, 1000);
`;

serverContent = serverContent.replace(oldHFStreamRegex, newPollStream);

fs.writeFileSync('server.ts', serverContent);
console.log("Patched server to INR polling");
