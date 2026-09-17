const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

// Delay activation to 1.5 ATR (from 1 ATR)
content = content.replace(/realINRPrice > pos\.entryPrice \+ atr\)/g, 'realINRPrice > pos.entryPrice + (atr * 1.5))');
content = content.replace(/realINRPrice < pos\.entryPrice - atr\)/g, 'realINRPrice < pos.entryPrice - (atr * 1.5))');
content = content.replace(/\/\/ Activate trail after 1 ATR of profit/g, '// Activate trail after 1.5 ATR of profit');

// Widen trailing stop distance to 2.5 ATR (from 1.5 ATR) to prevent premature stop outs
content = content.replace(/const dynamicStop = pos\.highestPrice - \(atr \* 1\.5\);/g, 'const dynamicStop = pos.highestPrice - (atr * 2.5);');
content = content.replace(/const dynamicStop = pos\.lowestPrice \+ \(atr \* 1\.5\);/g, 'const dynamicStop = pos.lowestPrice + (atr * 2.5);');

// Push Take Profit further out to 5 ATR (from 3 ATR) to let runners run
content = content.replace(/pos\.takeProfit = Math\.max\(pos\.takeProfit, realINRPrice \+ \(atr \* 3\)\);/g, 'pos.takeProfit = Math.max(pos.takeProfit, realINRPrice + (atr * 5));');
content = content.replace(/pos\.takeProfit = Math\.min\(pos\.takeProfit, realINRPrice - \(atr \* 3\)\);/g, 'pos.takeProfit = Math.min(pos.takeProfit, realINRPrice - (atr * 5));');

fs.writeFileSync('src/App.tsx', content);
