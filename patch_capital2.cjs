const fs = require('fs');
let c = fs.readFileSync('src/services/storagePersistenceService.ts', 'utf-8');
if (!c.includes('allTimeRealizedPnl: number')) {
  c = c.replace('dailyRealizedPnl: number;', 'dailyRealizedPnl: number;\n  allTimeRealizedPnl: number;');
}
if (!c.includes('allTimeRealizedPnl: 0,')) {
  c = c.replace('dailyRealizedPnl: 0,', 'dailyRealizedPnl: 0,\n    allTimeRealizedPnl: 0,');
}
c = c.replace('dailyRealizedPnl: savedDate === todayIST ? (Number(parsed.dailyRealizedPnl) || 0) : 0,',
'dailyRealizedPnl: savedDate === todayIST ? (Number(parsed.dailyRealizedPnl) || 0) : 0,\n        allTimeRealizedPnl: Number(parsed.allTimeRealizedPnl) || 0,');

fs.writeFileSync('src/services/storagePersistenceService.ts', c);
console.log('done');
