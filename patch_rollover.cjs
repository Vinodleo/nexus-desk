const fs = require('fs');

let content = fs.readFileSync('src/App.tsx', 'utf-8');

const target = `          const resetData = getInitialDailyTelemetry(currentIST);
          saveDailySampleTelemetry(resetData);
          return resetData;`;

const replacement = `          const resetData = getInitialDailyTelemetry(currentIST);
          saveDailySampleTelemetry(resetData);
          
          // CRITICAL FIX: Reset Daily P&L to 0 when the 24-hour cycle resets (Midnight IST)
          setDailyRealizedPnl(0);
          
          return resetData;`;

content = content.replace(target, replacement);

fs.writeFileSync('src/App.tsx', content);
console.log('patched');
