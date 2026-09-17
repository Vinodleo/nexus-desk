const fs = require('fs');
let content = fs.readFileSync('src/components/ChartTab.tsx', 'utf-8');
content = content.replace(/className=\{\\\`px-3/g, 'className={`px-3');
content = content.replace(/800"\\n            \}\\\`/g, '800"\n            }`');
content = content.replace(/border-stone-800"\\n            \}\\\`/g, 'border-stone-800"\n            }`');
content = content.replace(/border-stone-800"\\n\s*\}\\\`/g, 'border-stone-800"\n            }`');
content = content.replace(/\\\`/g, '`');
fs.writeFileSync('src/components/ChartTab.tsx', content);
