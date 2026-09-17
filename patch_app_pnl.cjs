const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

content = content.replace(/const pnlPercent = \(pnl \/ pos\.moneyPlaced\) \* 100;/g, 'const moneyPlaced = pos.entryPrice * pos.quantity;\n              const pnlPercent = (pnl / moneyPlaced) * 100;');

fs.writeFileSync('src/App.tsx', content);
