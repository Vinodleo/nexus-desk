const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf-8');

// Remove require
content = content.replace('const io = require("socket.io-client");', '');

// Add import to top
if (!content.includes('import { io } from "socket.io-client";') && !content.includes('import io from "socket.io-client";')) {
  content = 'import { io } from "socket.io-client";\n' + content;
}

fs.writeFileSync('server.ts', content);
console.log("Patched server import");
