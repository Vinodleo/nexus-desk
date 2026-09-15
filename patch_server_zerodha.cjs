const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const zerodhaImports = `
import { KiteConnect } from 'kiteconnect';
`;

code = code.replace(
  'import { GoogleGenAI, Type } from "@google/genai";',
  'import { GoogleGenAI, Type } from "@google/genai";\n' + zerodhaImports
);

const zerodhaRoutes = `
// ==========================================
// ZERODHA KITE CONNECT INTEGRATION ROUTES
// ==========================================

// Global state for demonstration (In production, store per-user in Firebase)
let kiteInstance: any = null;
let zerodhaAccessToken: string | null = null;

app.post("/api/zerodha/init", (req: Request, res: Response) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: "Missing API Key" });
  
  // Initialize the SDK
  kiteInstance = new KiteConnect({
    api_key: apiKey
  });

  const loginUrl = kiteInstance.getLoginURL();
  return res.json({ loginUrl });
});

app.post("/api/zerodha/callback", async (req: Request, res: Response) => {
  const { requestToken, apiSecret } = req.body;
  
  if (!kiteInstance) {
    return res.status(400).json({ error: "Kite instance not initialized" });
  }

  try {
    const response = await kiteInstance.generateSession(requestToken, apiSecret);
    zerodhaAccessToken = response.access_token;
    
    // Set the access token in the instance for future API calls (orders, positions)
    kiteInstance.setAccessToken(zerodhaAccessToken);

    return res.json({ 
      success: true, 
      access_token: zerodhaAccessToken,
      public_token: response.public_token 
    });
  } catch (err: any) {
    console.error("Zerodha session error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Mock order placement route
app.post("/api/zerodha/order", async (req: Request, res: Response) => {
  const { symbol, quantity, transaction_type, order_type, price } = req.body;
  
  if (!kiteInstance || !zerodhaAccessToken) {
    return res.status(401).json({ error: "Unauthorized. Please login to Zerodha first." });
  }

  try {
    // In production:
    // const orderId = await kiteInstance.placeOrder("regular", {
    //   exchange: "NSE",
    //   tradingsymbol: symbol,
    //   transaction_type: transaction_type,
    //   quantity: quantity,
    //   order_type: order_type,
    //   product: "MIS",
    //   price: price
    // });
    
    // Mocking the success for safety right now
    const orderId = "ZRD-" + Math.random().toString(36).substr(2, 9).toUpperCase();
    
    return res.json({ success: true, order_id: orderId });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

`;

code = code.replace(
  '// Server-Sent Events proxy for Binance',
  zerodhaRoutes + '\n// Server-Sent Events proxy for Binance'
);

fs.writeFileSync('server.ts', code);
