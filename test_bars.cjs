const fs = require('fs');
let content = fs.readFileSync('src/services/marketScannerService.ts', 'utf-8');
const regex = /const currentBar = bars\[bars\.length - 1\];/g;
const replacement = 'const currentBar = (bars && bars.length > 0) ? bars[bars.length - 1] : undefined;';
content = content.replace(regex, replacement);
fs.writeFileSync('src/services/marketScannerService.ts', content);
console.log("Patched marketScannerService.ts bars length");
