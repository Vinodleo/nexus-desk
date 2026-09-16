const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

// 1. Remove the old bad useEffect
const badUseEffectRegex = /\/\/ Automated price tick & position exit tracking[\s\S]*?\}, \[currentBar, closePositionWithAutopsy\]\);/g;
if (!content.match(badUseEffectRegex)) {
    console.error("Could not find bad useEffect");
} else {
    content = content.replace(badUseEffectRegex, '');
    console.log("Removed bad useEffect");
}

// 2. Rewrite the TICK handler
const oldTickRegex = /\/\/ Update active positions based on REAL LIVE PRICES[\s\S]*?return changed \? nextPositions : prev;\n          \}\);/g;
const newTickLogic = `// Update active positions based on REAL LIVE PRICES
          setActivePositions((prev) => {
            if (prev.length === 0) return prev;
            let changed = false;
            
            const nextPositions: Position[] = [];
            
            for (const pos of prev) {
              let realINRPrice = newPrices[pos.symbol];
              
              if (!realINRPrice) {
                const baseAsset = pos.symbol.split('/')[0];
                const binanceSymbol = \`\${baseAsset}/USDT\`;
                const liveCrypto = newPrices[binanceSymbol];
                if (liveCrypto) {
                  realINRPrice = liveCrypto * 83.5;
                }
              }
              
              if (!realINRPrice) {
                 nextPositions.push(pos);
                 continue;
              }
              
              const isLong = pos.direction === "LONG";
              
              // Evaluate Stop Loss and Take Profit against LIVE tick
              let hitExit = false;
              let exitReason: "STOP_LOSS" | "TAKE_PROFIT" | null = null;
              
              if (isLong) {
                 if (realINRPrice <= pos.stopLoss) { hitExit = true; exitReason = "STOP_LOSS"; }
                 else if (realINRPrice >= pos.takeProfit) { hitExit = true; exitReason = "TAKE_PROFIT"; }
              } else {
                 if (realINRPrice >= pos.stopLoss) { hitExit = true; exitReason = "STOP_LOSS"; }
                 else if (realINRPrice <= pos.takeProfit) { hitExit = true; exitReason = "TAKE_PROFIT"; }
              }
              
              if (hitExit && exitReason) {
                 setTimeout(() => {
                    closePositionWithAutopsy(pos, realINRPrice, exitReason!);
                 }, 10);
                 changed = true;
                 continue; // Don't push to nextPositions, it will be removed by closePositionWithAutopsy anyway, or we just drop it here
              }
              
              const pnl = (realINRPrice - pos.entryPrice) * pos.quantity * (isLong ? 1 : -1);
              const pnlPercent = (pnl / pos.moneyPlaced) * 100;
              
              if (Math.abs(realINRPrice - pos.currentPrice) > 0.0001) {
                changed = true;
              }
              
              nextPositions.push({
                ...pos,
                currentPrice: realINRPrice,
                unrealizedPnl: pnl,
                unrealizedPnlPercent: pnlPercent,
              });
            }
            
            return changed ? nextPositions : prev;
          });`;

if (!content.match(oldTickRegex)) {
    console.error("Could not find TICK handler");
} else {
    content = content.replace(oldTickRegex, newTickLogic);
    console.log("Patched TICK handler");
}

fs.writeFileSync('src/App.tsx', content);
