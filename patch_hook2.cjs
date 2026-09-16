const fs = require('fs');
let hook = fs.readFileSync('src/hooks/useLiveTickers.ts', 'utf-8');

hook = hook.replace(
  'const changePercent = ((last.close - first.open) / first.open) * 100;',
  'const changePercent = liveMarketStream.dailyChanges.get(sym) || (((last.close - first.open) / first.open) * 100);'
);

fs.writeFileSync('src/hooks/useLiveTickers.ts', hook);
