const fs = require('fs');
const file = 'src/services/storagePersistenceService.ts';
let content = fs.readFileSync(file, 'utf-8');

// We will just make sure all JSON.parse results are checked before returned if they are arrays
content = content.replace(/if \(Array\.isArray\(parsed\)\) \{/g, 'if (parsed && Array.isArray(parsed)) {');
content = content.replace(/const parsed = JSON\.parse\(raw\);\n\s*if \(\!parsed\) return;/g, 'const parsed = JSON.parse(raw); if (!parsed) return;');

fs.writeFileSync(file, content);
console.log("Patched storage");
