const fs = require('fs');
let content = fs.readFileSync('src/services/realDataBacktestService.ts', 'utf-8');

const regex = /const productId = \`\$\{base\}-USD\`;/g;
content = content.replace(
  'const base = symbol.replace(/USDT|USD|BUSD/g, "");',
  'const base = symbol.replace(/USDT|USD|BUSD|INR/g, "");'
);

const fetchCbRegex = /return data\.map\(\(c: any\) => \(\{[\s\S]*?\}\)\)/m;
const newCbMap = `
    const isINR = symbol.includes("INR");
    const fxRate = isINR ? 85.5 : 1; // Approx USD to INR rate to align historical chart with live CoinDCX INR feed
    
    return data.map((c: any) => ({
      timestamp: c[0] * 1000,
      open: parseFloat(c[3]) * fxRate,
      high: parseFloat(c[2]) * fxRate,
      low: parseFloat(c[1]) * fxRate,
      close: parseFloat(c[4]) * fxRate,
      volume: parseFloat(c[5]),
      dateStr: new Date(c[0] * 1000).toISOString().replace("T", " ").slice(0, 16),
    })).reverse();
`;
content = content.replace(/return data\.map\(\(c: any\) => \(\{[\s\S]*?\}\)\)\.reverse\(\);/m, newCbMap);

fs.writeFileSync('src/services/realDataBacktestService.ts', content);
console.log("Patched backtest");
