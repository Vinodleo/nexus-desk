const fs = require('fs');

let appContent = fs.readFileSync('src/App.tsx', 'utf-8');
appContent = appContent.replace(
  'const activeSymbols = ["BTC/INR", "ETH/INR", "SOL/INR", "AVAX/INR", "NEAR/INR"];',
  'const activeSymbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "AVAX/USDT", "NEAR/USDT"];'
);
fs.writeFileSync('src/App.tsx', appContent);


let uiContent = fs.readFileSync('src/services/liveMarketStreamService.ts', 'utf-8');
uiContent = uiContent.replace(
  'const activeSymbols = ["BTC/INR", "ETH/INR", "SOL/INR", "AVAX/INR", "NEAR/INR"];',
  'const activeSymbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "AVAX/USDT", "NEAR/USDT"];'
);

// We need to fetch B-BTC_USDT or similar if we use CoinDCX ticker, or just use Binance for USDT futures!
// Actually, CoinDCX's public ticker for spot USDT is just BTCUSDT? Let's check.
