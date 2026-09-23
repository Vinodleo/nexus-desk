import { Router, type Request, type Response } from "express";
import { KiteConnect, KiteTicker } from "kiteconnect";
import { broadcast } from "../realtime";

import { validate, zerodhaCallbackBody, zerodhaCandlesQuery, zerodhaOrderBody } from "../validation";

export const router = Router();

// ==========================================
// ZERODHA KITE CONNECT INTEGRATION ROUTES
// ==========================================

// Global state for demonstration (In production, store per-user in Firebase)
let kiteInstance: any = null;
let kiteTickerInstance: any = null;
let zerodhaAccessToken: string | null = null;

// Hardcode known NSE Instrument Tokens for the MVP symbols — shared between
// the live ticker subscription and the historical-candles endpoint below.
let ZERODHA_INSTRUMENT_MAP: Record<number, string> = {
  341249: "HDFCBANK",
  738561: "RELIANCE",
  2953217: "TCS",
  779521: "SBIN"
};

// Trading symbols we want tokens for — resolved dynamically from Zerodha's
// own real instrument list on each login (see /api/zerodha/callback) rather
// than more hardcoded numbers. Instrument tokens are stable long-term, but
// this avoids ever having to guess or hand-verify one again, and makes
// adding a new symbol later a one-line change here instead of a token hunt.
const ZERODHA_TARGET_SYMBOLS = [
  "HDFCBANK", "RELIANCE", "TCS", "SBIN",
  "ICICIBANK", "INFY", "HINDUNILVR", "TATAMOTORS", "SUNPHARMA", "BHARTIARTL"
];

router.post("/api/zerodha/init", (req: Request, res: Response) => {
  // API key comes from the server's own env var, matching how CoinDCX's
  // keys are handled — never asked of or exposed to the client.
  const apiKey = process.env.ZERODHA_API_KEY;
  if (!apiKey) return res.status(400).json({ error: "ZERODHA_API_KEY not set in environment." });

  // Initialize the SDK
  kiteInstance = new KiteConnect({
    api_key: apiKey
  });

  const loginUrl = kiteInstance.getLoginURL();
  return res.json({ loginUrl });
});

router.post("/api/zerodha/callback", validate({ body: zerodhaCallbackBody }), async (req: Request, res: Response) => {
  const { requestToken } = req.body;
  const apiSecret = process.env.ZERODHA_API_SECRET;
  if (!apiSecret) return res.status(400).json({ error: "ZERODHA_API_SECRET not set in environment." });
  if (!kiteInstance) {
    return res.status(400).json({ error: "Kite instance not initialized" });
  }

  try {
    const response = await kiteInstance.generateSession(requestToken, apiSecret);
    const accessToken: string = response.access_token;
    zerodhaAccessToken = accessToken;

    // Set the access token in the instance for future API calls (orders, positions)
    kiteInstance.setAccessToken(accessToken);

    // Resolve real instrument tokens for our target symbols from Zerodha's
    // own live instrument list, instead of trusting hardcoded numbers that
    // could be stale or wrong. This runs once per login — cheap, and it's
    // the only fully reliable source for these.
    try {
      const allInstruments = await kiteInstance.getInstruments("NSE");
      const resolved: Record<number, string> = {};
      let missing: string[] = [...ZERODHA_TARGET_SYMBOLS];
      for (const inst of allInstruments) {
        if (
          ZERODHA_TARGET_SYMBOLS.includes(inst.tradingsymbol) &&
          inst.segment === "NSE"
        ) {
          resolved[inst.instrument_token] = inst.tradingsymbol;
          missing = missing.filter((s) => s !== inst.tradingsymbol);
        }
      }
      if (Object.keys(resolved).length > 0) {
        ZERODHA_INSTRUMENT_MAP = resolved;
      }
      if (missing.length > 0) {
        console.warn(
          `[Zerodha] Could not resolve instrument tokens for: ${missing.join(
            ", "
          )} — they won't stream live data.`
        );
      }
    } catch (lookupErr) {
      console.warn(
        "[Zerodha] Instrument lookup failed, falling back to last known token map:",
        lookupErr
      );
    }

    // Initialize Kite Ticker for live Indian Equity data
    if (kiteTickerInstance) {
      kiteTickerInstance.disconnect();
    }

    // Use the api_key and newly minted access_token
    kiteTickerInstance = new KiteTicker({
      api_key: kiteInstance.api_key,
      access_token: accessToken
    });

    const instrumentMap = ZERODHA_INSTRUMENT_MAP;

    kiteTickerInstance.on("ticks", (ticks: any[]) => {
      const updates: Record<string, number> = {};
      ticks.forEach(tick => {
        const symbol = instrumentMap[tick.instrument_token];
        if (symbol && tick.last_price) {
          updates[symbol] = tick.last_price;
        }
      });

      if (Object.keys(updates).length > 0) {
        broadcast({ type: "TICK", data: updates });
      }
    });

    kiteTickerInstance.on("connect", () => {
      console.log("Connected to Zerodha Kite Ticker Stream");
      const tokens = Object.keys(instrumentMap).map(Number);
      kiteTickerInstance.subscribe(tokens);
      kiteTickerInstance.setMode(kiteTickerInstance.modeFull, tokens);
    });

    kiteTickerInstance.on("error", (e: any) => console.error("Kite Ticker Error:", e));
    kiteTickerInstance.on("close", () => console.log("Kite Ticker Closed"));

    kiteTickerInstance.connect();

    // The access token stays on the server; the client only needs to know
    // the session is live.
    return res.json({ success: true });
  } catch (err: any) {
    console.error("Zerodha session error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Real historical candles for equities, via the authenticated Kite Connect
// session — this is what powers the higher-timeframe (1h) confluence check
// for equities, the same way /api/coindcx/candles does for crypto. Requires
// an active Zerodha login (kiteInstance with a valid access token) — there's
// no public, unauthenticated equivalent of CoinDCX's candles endpoint.
router.get("/api/zerodha/candles", validate({ query: zerodhaCandlesQuery }), async (req: Request, res: Response) => {
  try {
    if (!kiteInstance || !zerodhaAccessToken) {
      return res.status(401).json({ error: "Not connected to Zerodha yet — log in first." });
    }
    const { symbol, interval } = req.query;
    if (!symbol || typeof symbol !== "string") {
      return res.status(400).json({ error: "symbol query param required, e.g. RELIANCE" });
    }

    const token = Object.keys(ZERODHA_INSTRUMENT_MAP).find(
      (t) => ZERODHA_INSTRUMENT_MAP[Number(t)] === symbol
    );
    if (!token) {
      return res.status(400).json({ error: `No known instrument token for ${symbol}` });
    }

    const to = new Date();
    const from = new Date(to.getTime() - 20 * 24 * 60 * 60 * 1000); // ~20 trading days of 60minute bars
    const data = await kiteInstance.getHistoricalData(
      token,
      interval || "60minute",
      from,
      to,
      false,
      false
    );
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to fetch Zerodha historical data" });
  }
});

// Mock order placement route
router.post("/api/zerodha/order", validate({ body: zerodhaOrderBody }), async (req: Request, res: Response) => {
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

