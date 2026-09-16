const fs = require('fs');
let c = fs.readFileSync('src/services/storagePersistenceService.ts', 'utf-8');

c = c.replace(
  'allTimeRealizedPnl: Number(parsed.allTimeRealizedPnl) || 0,',
  'allTimeRealizedPnl: parsed.allTimeRealizedPnl !== undefined ? Number(parsed.allTimeRealizedPnl) : (Number(parsed.equity) ? Number(parsed.equity) - 100000 : 0),'
);

fs.writeFileSync('src/services/storagePersistenceService.ts', c);
console.log('done');
