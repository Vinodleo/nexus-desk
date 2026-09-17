const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf-8');

const regexNewTrade = /const sym = innerData\.s\.replace\('INR', '\/INR'\);/;
const regexTicker = /const sym = payload\.s\.replace\('INR', '\/INR'\);/;

const normalizeFn = `
function normalizeCoinDCXSymbol(s) {
  let sym = s.replace('INR', '/INR');
  if (sym.startsWith('I-') || sym.startsWith('B-')) sym = sym.substring(2);
  sym = sym.replace('_', '');
  return sym;
}
`;

content = content.replace('const currentPrices = {};', normalizeFn + '\n  const currentPrices = {};');

content = content.replace(/const sym = payload\.s\.replace\('INR', '\/INR'\);/g, 'const sym = normalizeCoinDCXSymbol(payload.s);');
content = content.replace(/const sym = innerData\.s\.replace\('INR', '\/INR'\);/g, 'const sym = normalizeCoinDCXSymbol(innerData.s);');

fs.writeFileSync('server.ts', content);
