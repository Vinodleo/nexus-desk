const fs = require('fs');
let code = fs.readFileSync('src/components/NetworkTab.tsx', 'utf-8');
code = code.replace(/\\`/g, '`');
code = code.replace(/\\\$/g, '$');
fs.writeFileSync('src/components/NetworkTab.tsx', code);
