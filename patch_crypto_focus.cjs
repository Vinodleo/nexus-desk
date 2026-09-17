const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

const scanLogic = `
        // Prioritize Crypto Markets (80% of scans)
        const isCryptoFocus = Math.random() < 0.8;
        const cryptoSymbols = ["BTC/INR", "ETH/INR", "SOL/INR", "JUP/INR", "AVAX/INR", "NEAR/INR"];

        const scanResult = await scanAllMarkets({
          symbols: isCryptoFocus ? cryptoSymbols : undefined,
          activePositions: activePositionsRef.current,
`;

content = content.replace(/const scanResult = await scanAllMarkets\(\{\n\s*activePositions: activePositionsRef\.current,/g, scanLogic);

// Make scanning faster (every 1.5 seconds)
content = content.replace(/\}, 3500\);/g, '}, 1500);');

fs.writeFileSync('src/App.tsx', content);
