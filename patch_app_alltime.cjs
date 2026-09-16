const fs = require('fs');
let c = fs.readFileSync('src/App.tsx', 'utf-8');

c = c.replace(
  'const [dailyRealizedPnl, setDailyRealizedPnl] = useState<number>(() => loadStoredCapital().dailyRealizedPnl);',
  'const [dailyRealizedPnl, setDailyRealizedPnl] = useState<number>(() => loadStoredCapital().dailyRealizedPnl);\n  const [allTimeRealizedPnl, setAllTimeRealizedPnl] = useState<number>(() => loadStoredCapital().allTimeRealizedPnl || 0);'
);

c = c.replace(
  '      dailyRealizedPnl,',
  '      dailyRealizedPnl,\n      allTimeRealizedPnl,'
);

c = c.replace(
  '  }, [equity, cash, dailyRealizedPnl]);',
  '  }, [equity, cash, dailyRealizedPnl, allTimeRealizedPnl]);'
);

c = c.replace(
  '      setDailyRealizedPnl((prev) => Number((prev + finalPnl).toFixed(2)));',
  '      setDailyRealizedPnl((prev) => Number((prev + finalPnl).toFixed(2)));\n      setAllTimeRealizedPnl((prev) => Number((prev + finalPnl).toFixed(2)));'
);

c = c.replace(
  '        netPnl={closedTrades.reduce((acc, t) => acc + t.realizedPnl, 0)}',
  '        netPnl={allTimeRealizedPnl}'
);

fs.writeFileSync('src/App.tsx', c);
console.log('done');
