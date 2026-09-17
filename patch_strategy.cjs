const fs = require('fs');
let content = fs.readFileSync('src/services/strategyEngine.ts', 'utf-8');

// We want to increase the base multiplier logic for Take Profits, to make profits larger than losses (better RR).
content = content.replace(/const targetDistance = stopDistance \* 2\.2;/g, 'const targetDistance = stopDistance * 3.5;'); // Trend Following
content = content.replace(/const targetDistance = Math\.max\(atr \* tpMultBreakout, stopDistance \* 1\.5\);/g, 'const targetDistance = Math.max(atr * tpMultBreakout, stopDistance * 2.5);'); // Breakout
content = content.replace(/const targetDistance = Math\.abs\(price - vwap\);/g, 'const targetDistance = Math.abs(price - vwap) * 1.5;'); // Mean Reversion

fs.writeFileSync('src/services/strategyEngine.ts', content);
