const fs = require('fs');

// Patch App.tsx
let appContent = fs.readFileSync('src/App.tsx', 'utf-8');

appContent = appContent.replace(
  'const activeSymbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "AVAX/USDT", "NEAR/USDT"];',
  'const activeSymbols = ["BTC/INR", "ETH/INR", "SOL/INR", "AVAX/INR", "NEAR/INR"];'
);

fs.writeFileSync('src/App.tsx', appContent);
console.log('patched App.tsx');

// Patch liveMarketStreamService.ts
let streamContent = fs.readFileSync('src/services/liveMarketStreamService.ts', 'utf-8');

streamContent = streamContent.replace(
  'const activeSymbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "AVAX/USDT", "NEAR/USDT"];',
  'const activeSymbols = ["BTC/INR", "ETH/INR", "SOL/INR", "AVAX/INR", "NEAR/INR"];'
);

fs.writeFileSync('src/services/liveMarketStreamService.ts', streamContent);
console.log('patched liveMarketStreamService.ts');

