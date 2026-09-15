const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

// Ah, it was the original ws import lower down that conflicted.
code = code.replace("import { WebSocketServer, WebSocket as NodeWebSocket } from \"ws\";\n", "");

fs.writeFileSync('server.ts', code);
