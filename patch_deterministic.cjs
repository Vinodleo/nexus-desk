const fs = require('fs');
let content = fs.readFileSync('src/services/realDataBacktestService.ts', 'utf-8');

content = content.replace(
  'let price = symbol.includes("BTC") ? 64000 : symbol.includes("ETH") ? 2500 : symbol.includes("SOL") ? 145 : 1.0;',
  'const isINR = symbol.includes("INR");\n  const fx = isINR ? 85.5 : 1;\n  let price = (symbol.includes("BTC") ? 64000 : symbol.includes("ETH") ? 2500 : symbol.includes("SOL") ? 145 : 1.0) * fx;'
);

fs.writeFileSync('src/services/realDataBacktestService.ts', content);
