const fs = require('fs');
let code = fs.readFileSync('src/components/TradeAutopsyCard.tsx', 'utf-8');
code = code.replace(/\\`/g, '`');
code = code.replace(/\\\$/g, '$');
fs.writeFileSync('src/components/TradeAutopsyCard.tsx', code);
