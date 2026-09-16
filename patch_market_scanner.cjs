const fs = require('fs');

// Patch App.tsx
let appContent = fs.readFileSync('src/App.tsx', 'utf-8');

appContent = appContent.replace(
  'import { liveMarketStream } from "./services/liveMarketStreamService";',
  'import { liveMarketStream } from "./services/liveMarketStreamService";'
);
if (!appContent.includes('import { liveMarketStream }')) {
  appContent = appContent.replace(
    'import { SUPPORTED_SYMBOLS, generateInitialExperienceDatabase } from "./services/marketDataService";',
    'import { SUPPORTED_SYMBOLS, generateInitialExperienceDatabase } from "./services/marketDataService";\nimport { liveMarketStream } from "./services/liveMarketStreamService";'
  );
}

const buildBarsMapOld = `
      const scanResult = await scanAllMarkets({
        activePositions,
        dailyRealizedPnl,
        failureState,
        experiences,
      });
`;
const buildBarsMapNew = `
      let barsMap;
      if (tapeMode === "LIVE TAPE") {
        barsMap = {};
        const activeLive = liveMarketStream.getActiveSymbols();
        activeLive.forEach(sym => {
          const bars = liveMarketStream.getBars(sym);
          if (bars) barsMap[sym] = bars;
        });
      }
      const scanResult = await scanAllMarkets({
        activePositions,
        dailyRealizedPnl,
        failureState,
        experiences,
        barsMap,
      });
`;
appContent = appContent.replace(buildBarsMapOld, buildBarsMapNew);
appContent = appContent.replace(buildBarsMapOld, buildBarsMapNew); // Replace both occurrences (manual and continuous)

fs.writeFileSync('src/App.tsx', appContent);
console.log('patched App.tsx');

// Patch marketScannerService.ts
let scannerContent = fs.readFileSync('src/services/marketScannerService.ts', 'utf-8');
const oldBars = `
    let bars = generateInitialBars(symbolConfig, 75);
`;
const newBars = `
    let bars = options.barsMap && options.barsMap[symbolConfig.symbol] 
        ? options.barsMap[symbolConfig.symbol] 
        : generateInitialBars(symbolConfig, 75);
    
    // If bars map provided but missing this symbol (and we are strictly live), skip
    if (options.barsMap && !options.barsMap[symbolConfig.symbol]) {
        continue;
    }
`;
scannerContent = scannerContent.replace(oldBars, newBars);

fs.writeFileSync('src/services/marketScannerService.ts', scannerContent);
console.log('patched marketScannerService.ts');

