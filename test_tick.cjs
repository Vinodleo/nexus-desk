const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

// We want to add console.log("TICK:", msg.data);
content = content.replace(/if \(msg\.type === 'TICK'\) \{/, 'if (msg.type === "TICK") {\n          // console.log("TICK received", msg.data);');

fs.writeFileSync('src/App.tsx', content);
