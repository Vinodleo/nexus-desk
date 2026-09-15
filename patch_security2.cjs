const fs = require('fs');
let code = fs.readFileSync('src/components/SecurityConsoleModal.tsx', 'utf-8');

// I replaced too much in the regex. I will restore it safely.
// Let's just do a clean git checkout if possible, or I will manually find and replace the section without regex.
