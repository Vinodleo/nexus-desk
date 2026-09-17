const fs = require('fs');
const file = 'src/services/storagePersistenceService.ts';
let content = fs.readFileSync(file, 'utf-8');

// replace return JSON.parse(data) with return JSON.parse(data) || defaultVal
content = content.replace(/return JSON\.parse\(data\);/g, (match, offset, str) => {
    // We need to figure out what the default value is in each catch block
    return 'const parsed = JSON.parse(data); return parsed || null;';
});
