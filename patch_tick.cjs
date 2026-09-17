const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

const tickRegex = /\/\/ Evaluate Stop Loss and Take Profit against LIVE tick[\s\S]*?const pnlPercent = \(pnl \/ pos\.moneyPlaced\) \* 100;/;

const newTickLogic = `// Evaluate Stop Loss and Take Profit against LIVE tick
              let hitExit = false;
              let exitReason: "STOP_LOSS" | "TAKE_PROFIT" | null = null;
              
              const atr = pos.atrAtEntry || (pos.entryPrice * 0.005);
              
              if (isLong) {
                 // Trailing Stop Logic (Long)
                 pos.highestPrice = Math.max(pos.highestPrice || pos.entryPrice, realINRPrice);
                 
                 // Activate trail after 1 ATR of profit
                 if (!pos.trailActive && realINRPrice > pos.entryPrice + atr) {
                     pos.trailActive = true;
                 }
                 
                 // Update trailing stop (trail distance = 1.5 ATR)
                 if (pos.trailActive) {
                     const dynamicStop = pos.highestPrice - (atr * 1.5);
                     if (dynamicStop > pos.stopLoss) {
                         pos.stopLoss = dynamicStop;
                         // Push take profit further out so we don't cap the runner
                         pos.takeProfit = Math.max(pos.takeProfit, realINRPrice + (atr * 3));
                         changed = true;
                     }
                 }
              
                 if (realINRPrice <= pos.stopLoss) { hitExit = true; exitReason = "STOP_LOSS"; }
                 else if (realINRPrice >= pos.takeProfit) { hitExit = true; exitReason = "TAKE_PROFIT"; }
              } else {
                 // Trailing Stop Logic (Short)
                 pos.lowestPrice = Math.min(pos.lowestPrice || pos.entryPrice, realINRPrice);
                 
                 // Activate trail after 1 ATR of profit
                 if (!pos.trailActive && realINRPrice < pos.entryPrice - atr) {
                     pos.trailActive = true;
                 }
                 
                 // Update trailing stop
                 if (pos.trailActive) {
                     const dynamicStop = pos.lowestPrice + (atr * 1.5);
                     if (dynamicStop < pos.stopLoss) {
                         pos.stopLoss = dynamicStop;
                         // Push take profit further out so we don't cap the runner
                         pos.takeProfit = Math.min(pos.takeProfit, realINRPrice - (atr * 3));
                         changed = true;
                     }
                 }
              
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
              const pnlPercent = (pnl / pos.moneyPlaced) * 100;`;

if (!content.match(tickRegex)) {
    console.error("Could not find tickRegex");
} else {
    content = content.replace(tickRegex, newTickLogic);
    console.log("Patched TICK handler for Trailing Stops");
}

fs.writeFileSync('src/App.tsx', content);
