const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

// I also need to fix the NodeWebSocket reference I broke.
code = code.replace("function setupClient(client: NodeWebSocket) {", "function setupClient(client: WebSocket) {");
code = code.replace("function checkLiveness(ws: NodeWebSocket) {", "function checkLiveness(ws: WebSocket) {");
// Just in case it's typed elsewhere
code = code.replace(/NodeWebSocket/g, "WebSocket");

fs.writeFileSync('server.ts', code);
