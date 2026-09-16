const fs = require('fs');

let serverContent = fs.readFileSync('server.ts', 'utf-8');

const oldSse = `
// Server-Sent Events proxy for Binance to bypass WS blockages
app.get("/api/stream/binance", (req, res) => {
  const streams = req.query.streams;
  if (!streams || typeof streams !== 'string') {
    return res.status(400).json({ error: "Missing streams param" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Flush headers immediately
  res.flushHeaders();

  const keepAlive = setInterval(() => {
    res.write(':\\n\\n'); // SSE comment to keep connection alive
  }, 30000);

  const binanceUrl = \`wss://data-stream.binance.vision/stream?streams=\${streams}\`;
  const binanceWs = new WebSocket(binanceUrl);

  binanceWs.on('open', () => {
    console.log('Connected to Binance SSE proxy:', binanceUrl);
  });

  binanceWs.on('message', (data) => {
    // Send as SSE message
    res.write(\`data: \${data.toString()}\\n\\n\`);
  });

  binanceWs.on('close', () => {
    clearInterval(keepAlive);
    res.end();
  });

  binanceWs.on('error', (err) => {
    console.error('Binance SSE proxy error:', err);
    clearInterval(keepAlive);
    res.end();
  });

  req.on('close', () => {
    clearInterval(keepAlive);
    binanceWs.close();
  });
});
`;

const newSse = `
// CoinDCX Polling Proxy (CoinDCX doesn't have public K-line WebSockets, so we poll their public REST API)
app.get("/api/stream/coindcx", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const activeMarkets = ['BTCINR', 'ETHINR', 'SOLINR', 'AVAXINR', 'NEARINR'];

  const pollInterval = setInterval(async () => {
    try {
      const response = await fetch('https://public.coindcx.com/exchange/ticker');
      const data = await response.json();
      
      const updates = {};
      data.forEach(ticker => {
        if (activeMarkets.includes(ticker.market)) {
          // Format the symbol back to UI expectations (e.g. BTCINR -> BTC/INR)
          const formattedSym = ticker.market.replace('INR', '/INR');
          updates[formattedSym] = {
            c: parseFloat(ticker.last_price),
            h: parseFloat(ticker.high),
            l: parseFloat(ticker.low),
            v: parseFloat(ticker.volume),
            t: parseInt(ticker.timestamp) * 1000 // Convert seconds to MS
          };
        }
      });
      
      res.write(\`data: \${JSON.stringify(updates)}\\n\\n\`);
    } catch (e) {
      console.error("CoinDCX Poll Error:", e.message);
    }
  }, 2000); // Poll every 2 seconds

  req.on('close', () => {
    clearInterval(pollInterval);
    res.end();
  });
});
`;

serverContent = serverContent.replace(oldSse, newSse);


const oldWsTicker = `
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
      // Approximating INR rate as 84.5 for UI parity with CoinDCX
          const INR_RATE = 95.90; // Updated to match current CoinGecko/CoinDCX premium rate
          client.send(JSON.stringify({
            type: 'TICK',
            data: {
              'BTC/INR': (latestPrices['BTCUSDT'] || 0) * INR_RATE,
              'ETH/INR': (latestPrices['ETHUSDT'] || 0) * INR_RATE,
              'SOL/INR': (latestPrices['SOLUSDT'] || 0) * INR_RATE,
              'AVAX/INR': (latestPrices['AVAXUSDT'] || 0) * INR_RATE
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

const newWsTicker = `
  // We use the same CoinDCX Polling logic for the top ticker tape
  setInterval(async () => {
    try {
      const response = await fetch('https://public.coindcx.com/exchange/ticker');
      const data = await response.json();
      
      const payload: Record<string, number> = {};
      data.forEach((ticker: any) => {
        if (['BTCINR', 'ETHINR', 'SOLINR', 'AVAXINR'].includes(ticker.market)) {
          payload[ticker.market.replace('INR', '/INR')] = parseFloat(ticker.last_price);
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
  }, 3000);
`;

// It's safer to just regex replace the whole binance ws block
serverContent = serverContent.replace(/const binanceWs = new WebSocket\([\s\S]*?binanceWs\.on\('error'[\s\S]*?\}\);/, newWsTicker);


fs.writeFileSync('server.ts', serverContent);
console.log('patched server.ts to use CoinDCX');

// Patch liveMarketStreamService.ts to hit our new SSE endpoint
let uiContent = fs.readFileSync('src/services/liveMarketStreamService.ts', 'utf-8');
const oldUiSse = `const url = \`/api/stream/binance?streams=\${streams}\`;`;
const newUiSse = `const url = \`/api/stream/coindcx\`;`;

const oldParse = `
        if (payload.e === "kline") {
          const k = payload.k;
          let symbolInternal = payload.s;
          if (symbolInternal.endsWith("USDT")) symbolInternal = symbolInternal.replace("USDT", "/USDT");
          
          if (!this.marketData.has(symbolInternal)) return;
          const bars = this.marketData.get(symbolInternal)!;
          const lastBar = bars[bars.length - 1];
          
          const updatedRaw: MarketBar = {
            time: new Date(k.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            timestampMs: k.t,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
          };
`;

const newParse = `
        // Custom parser for CoinDCX SSE proxy
        Object.keys(rawPayload).forEach(symbolInternal => {
          if (!this.marketData.has(symbolInternal)) return;
          const k = rawPayload[symbolInternal];
          const bars = this.marketData.get(symbolInternal)!;
          const lastBar = bars[bars.length - 1];
          
          // CoinDCX API only gives us 24hr high/low/close, not 1-min klines. 
          // So we construct a synthetic 1-min bar using the last price.
          // In a production app, you would hit their candlestick API endpoint.
          const updatedRaw: MarketBar = {
            time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            timestampMs: Date.now(),
            open: lastBar.open, // Keep open same for the minute
            high: Math.max(lastBar.high, k.c), 
            low: Math.min(lastBar.low, k.c),
            close: k.c,
            volume: lastBar.volume, // Mock volume or use 24h
          };
`;

uiContent = uiContent.replace(oldUiSse, newUiSse);
uiContent = uiContent.replace(oldParse, newParse);
fs.writeFileSync('src/services/liveMarketStreamService.ts', uiContent);

