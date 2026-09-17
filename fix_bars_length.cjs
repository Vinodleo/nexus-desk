const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

content = content.replace(/const currentAtr = bars\.length > 0/g, 'const currentAtr = (bars && bars.length > 0)');

fs.writeFileSync('src/App.tsx', content);
console.log("Fixed bars.length issue");
