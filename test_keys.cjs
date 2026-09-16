const crypto = require('crypto');
// We will test creating a dummy order payload to see if the signature generation matches coindcx docs
// To really test if the API keys are connected, we need an endpoint that hits CoinDCX to check balances.

const fs = require('fs');
let serverContent = fs.readFileSync('server.ts', 'utf-8');

const checkBalanceRoute = `
app.get("/api/coindcx/balances", async (req, res) => {
  try {
    const apiKey = process.env.COINDCX_API_KEY;
    const apiSecret = process.env.COINDCX_API_SECRET;

    if (!apiKey || !apiSecret) {
      return res.status(401).json({ success: false, error: "Missing CoinDCX API Keys" });
    }

    const timestamp = Math.floor(Date.now());
    const body = { timestamp };
    const payload = Buffer.from(JSON.stringify(body)).toString('base64');
    const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');

    const response = await fetch('https://api.coindcx.com/exchange/v1/users/balances', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-APIKEY': apiKey,
        'X-AUTH-SIGNATURE': signature
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) {
       return res.status(response.status).json({ success: false, error: data.message || "Failed to fetch balances", data });
    }

    res.json({ success: true, balances: data });
  } catch (error) {
    res.status(500).json({ success: false, error: "Network error" });
  }
});
`;

serverContent = serverContent.replace(
  'app.get("/api/coindcx/ticker",',
  checkBalanceRoute + '\napp.get("/api/coindcx/ticker",'
);

// add crypto import if missing
if (!serverContent.includes('import crypto from "crypto";')) {
  serverContent = 'import crypto from "crypto";\n' + serverContent;
}

fs.writeFileSync('server.ts', serverContent);
