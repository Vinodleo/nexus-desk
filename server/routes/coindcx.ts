import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import { liveRiskSnapshot } from "../liveOrderGuard";
import { currentPrices } from "../realtime";
import { getCoinDcxTicker } from "../coindcxTicker";

import { validate, cancelOrderBody, coinDcxCandlesQuery } from "../validation";

export const router = Router();

// CoinDCX credentials live only in the server environment. They are never
// accepted from, or returned to, the browser.
export function getCoinDcxCredentials(_req?: Request): { apiKey: string; apiSecret: string } {
  return {
    apiKey: (process.env.COINDCX_API_KEY || "").trim(),
    apiSecret: (process.env.COINDCX_API_SECRET || "").trim(),
  };
}

function maskKey(apiKey: string): string {
  return apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : "ACTIVE";
}

// Credential + live-risk status for the UI (no secrets).
router.get("/api/coindcx/status", (_req: Request, res: Response) => {
  const { apiKey, apiSecret } = getCoinDcxCredentials();
  res.json({
    success: true,
    configured: Boolean(apiKey && apiSecret),
    keyMasked: apiKey ? maskKey(apiKey) : null,
    liveRisk: liveRiskSnapshot(),
  });
});

// Server-observed reference price for a CoinDCX market (e.g. "BTCINR"):
// the live socket cache first, then CoinDCX's public ticker.
export async function getReferencePrice(market: string): Promise<number | undefined> {
  const cached = currentPrices[market.replace(/INR$/, "/INR")];
  if (cached) return cached;
  try {
    const data: any[] = await getCoinDcxTicker();
    const ticker = data.find((t: any) => t.market === market);
    const price = ticker ? parseFloat(ticker.last_price) : NaN;
    return Number.isFinite(price) ? price : undefined;
  } catch {
    return undefined;
  }
}

// Reusable CoinDCX balance fetcher & validator
const handleCoinDcxBalances = async (req: Request, res: Response) => {
  try {
    const { apiKey, apiSecret } = getCoinDcxCredentials(req);

    if (!apiKey || !apiSecret) {
      return res.status(401).json({
        success: false,
        error: "CoinDCX API credentials are not configured on the server (COINDCX_API_KEY / COINDCX_API_SECRET).",
        code: "MISSING_KEYS"
      });
    }

    const timestamp = Math.floor(Date.now());
    const body = { timestamp };

    // CoinDCX signs raw JSON payload directly with HMAC-SHA256
    const payload = JSON.stringify(body);
    const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');

    const response = await fetch('https://api.coindcx.com/exchange/v1/users/balances', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-APIKEY': apiKey,
        'X-AUTH-SIGNATURE': signature
      },
      body: payload
    });

    const data: any = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: data.message || `CoinDCX exchange returned code ${response.status}`,
        code: "AUTH_FAILED",
        raw: data
      });
    }

    // Process currency balances
    const balances = Array.isArray(data) ? data : [];
    const inrItem = balances.find((b: any) => b.currency === "INR");
    const usdtItem = balances.find((b: any) => b.currency === "USDT");

    const totalInr = inrItem ? Number(inrItem.balance || 0) : 0;
    const lockedInr = inrItem ? Number(inrItem.locked_balance || 0) : 0;
    const availableInr = Number(Math.max(0, totalInr - lockedInr).toFixed(2));

    const totalUsdt = usdtItem ? Number(usdtItem.balance || 0) : 0;
    const lockedUsdt = usdtItem ? Number(usdtItem.locked_balance || 0) : 0;
    const availableUsdt = Number(Math.max(0, totalUsdt - lockedUsdt).toFixed(4));

    return res.json({
      success: true,
      balances,
      totalInr,
      availableInr,
      lockedInr,
      totalUsdt,
      availableUsdt,
      lockedUsdt,
      keyMasked: maskKey(apiKey),
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("[CoinDCX Balances] Network error:", error);
    return res.status(500).json({ success: false, error: error?.message || "Network error fetching CoinDCX balance" });
  }
};

router.get("/api/coindcx/balances", handleCoinDcxBalances);
router.post("/api/coindcx/balances", handleCoinDcxBalances);

// Explicit HMAC credentials validation endpoint
router.post("/api/coindcx/validate-keys", async (req: Request, res: Response) => {
  return handleCoinDcxBalances(req, res);
});

// CoinDCX Order Cancellation endpoint
router.post("/api/coindcx/orders/cancel", validate({ body: cancelOrderBody }), async (req: Request, res: Response) => {
  try {
    const { apiKey, apiSecret } = getCoinDcxCredentials(req);
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: "Order ID required for cancellation" });
    }

    if (!apiKey || !apiSecret) {
      return res.status(401).json({ success: false, error: "CoinDCX API credentials are not configured on the server" });
    }

    const timestamp = Math.floor(Date.now());
    const body = { id, timestamp };
    const payload = JSON.stringify(body);
    const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');

    const response = await fetch('https://api.coindcx.com/exchange/v1/orders/cancel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-APIKEY': apiKey,
        'X-AUTH-SIGNATURE': signature
      },
      body: payload
    });

    const data: any = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ success: false, error: data?.message || "Failed to cancel order", data });
    }

    return res.json({ success: true, message: "Order cancelled successfully on CoinDCX", data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/coindcx/ticker", async (req, res) => {
  try {
    res.json(await getCoinDcxTicker());
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch from CoinDCX" });
  }
});

// Real historical candles, proxied from CoinDCX's public candles API
// (https://public.coindcx.com/market_data/candles) — used for the
// higher-timeframe (1h) confluence check, so that check is grounded in
// CoinDCX's own real historical data rather than synthetic backfill.
router.get("/api/coindcx/candles", validate({ query: coinDcxCandlesQuery }), async (req, res) => {
  try {
    const { symbol, interval, limit } = req.query;
    if (!symbol || typeof symbol !== "string") {
      return res.status(400).json({ error: "symbol query param required, e.g. XRP" });
    }

    const pair = `I-${symbol}_INR`;
    const params = new URLSearchParams({
      pair,
      interval: typeof interval === "string" ? interval : "1h",
      limit: String(Math.min(1000, Math.max(1, Number(limit) || 100))),
    });
    const url = `https://public.coindcx.com/market_data/candles?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
      return res.status(response.status).json({ error: `CoinDCX candles returned ${response.status}` });
    }

    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to fetch candles from CoinDCX" });
  }
});

