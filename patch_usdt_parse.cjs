const fs = require('fs');

// Patch liveMarketStreamService.ts
let uiContent = fs.readFileSync('src/services/liveMarketStreamService.ts', 'utf-8');

uiContent = uiContent.replace(
  'const sym = t.market.replace("INR", "/INR");',
  'let sym = t.market.replace("INR", "/INR");\n         if (t.market.endsWith("USDT")) sym = t.market.replace("USDT", "/USDT");'
);

fs.writeFileSync('src/services/liveMarketStreamService.ts', uiContent);


// Patch server.ts
let serverContent = fs.readFileSync('server.ts', 'utf-8');
const oldServerPoll = `const activeMarkets = ['BTCINR', 'ETHINR', 'SOLINR', 'AVAXINR', 'NEARINR'];`;
const newServerPoll = `const activeMarkets = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AVAXUSDT', 'NEARUSDT'];`;
serverContent = serverContent.replace(oldServerPoll, newServerPoll);

const oldFormatSym = `const formattedSym = ticker.market.replace('INR', '/INR');`;
const newFormatSym = `const formattedSym = ticker.market.replace('USDT', '/USDT');`;
serverContent = serverContent.replace(oldFormatSym, newFormatSym);

fs.writeFileSync('server.ts', serverContent);

