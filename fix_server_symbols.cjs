const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf-8');

const regexTicker = /if \(\['BTCINR', 'ETHINR', 'SOLINR', 'AVAXINR', 'NEARINR'\]\.includes\(payload\.s\)\) \{\n\s*const sym = payload\.s\.replace\('INR', '\/INR'\);/;

const fixedTicker = `if (payload.s.endsWith('INR')) {
          let sym = payload.s.replace('INR', '/INR');
          if (sym.startsWith('I-') || sym.startsWith('B-')) {
            sym = sym.substring(2);
          }
          if (sym.includes('_')) {
             sym = sym.replace('_', '');
          }`;

// Let's just create a general normalizeSymbol function in server.ts
