const fs = require('fs');

let serverContent = fs.readFileSync('server.ts', 'utf-8');

const newRoute = `
app.get("/api/coindcx/ticker", async (req, res) => {
  try {
    const response = await fetch('https://public.coindcx.com/exchange/ticker');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch from CoinDCX" });
  }
});
`;

// Insert after app.get("/api/health"
serverContent = serverContent.replace(
  'app.get("/api/health", (_req: Request, res: Response) => {\n  res.json({ status: "ok" });\n});',
  'app.get("/api/health", (_req: Request, res: Response) => {\n  res.json({ status: "ok" });\n});\n' + newRoute
);

fs.writeFileSync('server.ts', serverContent);


let uiContent = fs.readFileSync('src/services/liveMarketStreamService.ts', 'utf-8');
uiContent = uiContent.replace(
  "const res = await fetch('https://public.coindcx.com/exchange/ticker');",
  "const res = await fetch('/api/coindcx/ticker');"
);

fs.writeFileSync('src/services/liveMarketStreamService.ts', uiContent);

