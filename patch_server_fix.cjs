const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

// I accidentally imported WebSocketServer twice.
code = code.replace(
  "import { WebSocketServer } from 'ws';\nimport { WebSocketServer } from 'ws';\nimport WebSocket from 'ws';",
  "import { WebSocketServer } from 'ws';\nimport WebSocket from 'ws';"
);

code = code.replace(
  "import { WebSocketServer } from 'ws';\nimport WebSocket from 'ws';\nimport { WebSocketServer } from 'ws';\nimport WebSocket from 'ws';",
  "import { WebSocketServer } from 'ws';\nimport WebSocket from 'ws';"
);

fs.writeFileSync('server.ts', code);
