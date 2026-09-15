const fs = require('fs');

// Patch LearningTab.tsx
let ltCode = fs.readFileSync('src/components/LearningTab.tsx', 'utf-8');
const buttonRegex = /\{\s*onResetMemoryToBaseline\s*&&\s*\([\s\S]*?<\/button>\s*\)\s*\}/m;
ltCode = ltCode.replace(buttonRegex, '');

// Also remove it from props if we want to be thorough, but we don't strictly have to if we just removed the button.
fs.writeFileSync('src/components/LearningTab.tsx', ltCode);

// Patch App.tsx
let appCode = fs.readFileSync('src/App.tsx', 'utf-8');
const resetPropRegex = /onResetMemoryToBaseline=\{\(\) => \{[\s\S]*?\}\}/m;
appCode = appCode.replace(resetPropRegex, '');
fs.writeFileSync('src/App.tsx', appCode);

