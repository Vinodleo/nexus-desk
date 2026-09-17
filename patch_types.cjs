const fs = require('fs');
let content = fs.readFileSync('src/types.ts', 'utf-8');
content = content.replace(/isSelfApproved\?\: boolean;/g, 'isSelfApproved?: boolean;\n  highestPrice?: number;\n  lowestPrice?: number;\n  trailActive?: boolean;\n  atrAtEntry?: number;');
fs.writeFileSync('src/types.ts', content);
