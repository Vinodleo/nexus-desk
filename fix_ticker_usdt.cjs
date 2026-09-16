const fs = require('fs');
let serverContent = fs.readFileSync('server.ts', 'utf-8');

serverContent = serverContent.replace(
  "if (['BTCINR', 'ETHINR', 'SOLINR', 'AVAXINR'].includes(ticker.market)) {",
  "if (['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AVAXUSDT'].includes(ticker.market)) {"
);

serverContent = serverContent.replace(
  "payload[ticker.market.replace('INR', '/INR')] = parseFloat(ticker.last_price);",
  "payload[ticker.market.replace('USDT', '/USDT')] = parseFloat(ticker.last_price);"
);

fs.writeFileSync('server.ts', serverContent);
