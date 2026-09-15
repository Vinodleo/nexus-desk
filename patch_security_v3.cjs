const fs = require('fs');
let code = fs.readFileSync('src/components/SecurityConsoleModal.tsx', 'utf-8');

// fix literal \n
code = code.replace(/\\n/g, '\n');

fs.writeFileSync('src/components/SecurityConsoleModal.tsx', code);
