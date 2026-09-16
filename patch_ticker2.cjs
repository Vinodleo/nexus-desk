const fs = require('fs');
let serverContent = fs.readFileSync('server.ts', 'utf-8');

const oldPoll = `  setInterval(async () => {
    try {
      const response = await fetch('https://public.coindcx.com/exchange/ticker');
      const data = await response.json();
      
      const payload: Record<string, number> = {};
      data.forEach((ticker: any) => {
        if (['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AVAXUSDT'].includes(ticker.market)) {
          payload[ticker.market.replace('USDT', '/USDT')] = parseFloat(ticker.last_price);
        }
      });

      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'TICK',
            data: payload
          }));
        }
      });
    } catch (e: any) {
      // silent fail on tape poll
    }
  }, 3000);`;

const newHFStream = `
  // High-Frequency Binance Ticker Stream for the UI tape (sub-second)
  const binanceWs = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
  
  binanceWs.on('message', (data) => {
    try {
      const tickers = JSON.parse(data.toString());
      const payload = {};
      let updated = false;
      
      tickers.forEach((t: any) => {
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

serverContent = serverContent.replace(oldPoll, newHFStream);
fs.writeFileSync('server.ts', serverContent);

