const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

const manualScanLogic = `
      // Prioritize Crypto Markets
      const cryptoSymbols = ["BTC/INR", "ETH/INR", "SOL/INR", "JUP/INR", "AVAX/INR", "NEAR/INR"];
      const isCryptoFocus = Math.random() < 0.8;

      const scanResult = await scanAllMarkets({
        symbols: isCryptoFocus ? cryptoSymbols : undefined,
        activePositions,
`;

content = content.replace(/const scanResult = await scanAllMarkets\(\{\n\s*activePositions,/g, manualScanLogic);

fs.writeFileSync('src/App.tsx', content);
