const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const sseRoute = `
// Server-Sent Events proxy for Binance to bypass WS blockages
app.get("/api/stream/binance", (req, res) => {
  const streams = req.query.streams;
  if (!streams || typeof streams !== 'string') {
    return res.status(400).json({ error: "Missing streams param" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Flush headers immediately
  res.flushHeaders();

  const binanceUrl = \`wss://data-stream.binance.vision/stream?streams=\${streams}\`;
  const binanceWs = new NodeWebSocket(binanceUrl);

  binanceWs.on('open', () => {
    console.log('Connected to Binance SSE proxy:', binanceUrl);
  });

  binanceWs.on('message', (data) => {
    // Send as SSE message
    res.write(\`data: \${data.toString()}\\n\\n\`);
  });

  binanceWs.on('close', () => {
    res.end();
  });

  binanceWs.on('error', (err) => {
    console.error('Binance SSE proxy error:', err);
    res.end();
  });

  req.on('close', () => {
    binanceWs.close();
  });
});
`;

// Insert after app.use(express.json());
code = code.replace('app.use(express.json());', 'app.use(express.json());\n' + sseRoute);

// Remove WebSocketServer
const wsStart = code.indexOf('const wss = new WebSocketServer({ server });');
if (wsStart > -1) {
  code = code.substring(0, wsStart);
  code += "}\n\nstartServer();\n";
}

fs.writeFileSync('server.ts', code);
