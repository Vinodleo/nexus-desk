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

serverContent = serverContent.replace(
  'app.get("/api/health",',
  newRoute + '\napp.get("/api/health",'
);

fs.writeFileSync('server.ts', serverContent);
