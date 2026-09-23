import io from "socket.io-client";
import crypto from "crypto";
import express, { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { KiteConnect, KiteTicker } from 'kiteconnect';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// ==========================================
// ZERODHA KITE CONNECT INTEGRATION ROUTES
// ==========================================

// Global state for demonstration (In production, store per-user in Firebase)
let kiteInstance: any = null;
let kiteTickerInstance: any = null;
let globalWss: WebSocketServer | null = null;
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

app.post("/api/zerodha/init", (req: Request, res: Response) => {
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

app.post("/api/zerodha/callback", async (req: Request, res: Response) => {
  const { requestToken } = req.body;
  const apiSecret = process.env.ZERODHA_API_SECRET;
  if (!apiSecret) return res.status(400).json({ error: "ZERODHA_API_SECRET not set in environment." });
  if (!kiteInstance) {
    return res.status(400).json({ error: "Kite instance not initialized" });
  }

  try {
    const response = await kiteInstance.generateSession(requestToken, apiSecret);
    zerodhaAccessToken = response.access_token;

    // Set the access token in the instance for future API calls (orders, positions)
    kiteInstance.setAccessToken(zerodhaAccessToken);

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
      access_token: zerodhaAccessToken
    });

    const instrumentMap = ZERODHA_INSTRUMENT_MAP;

    kiteTickerInstance.on("ticks", (ticks: any[]) => {
      if (!globalWss) return;
      const updates: Record<string, number> = {};
      ticks.forEach(tick => {
        const symbol = instrumentMap[tick.instrument_token];
        if (symbol && tick.last_price) {
          updates[symbol] = tick.last_price;
        }
      });

      if (Object.keys(updates).length > 0) {
        // Broadcast to all connected clients
        globalWss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "TICK", data: updates }));
          }
        });
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

// Real historical candles for equities, via the authenticated Kite Connect
// session — this is what powers the higher-timeframe (1h) confluence check
// for equities, the same way /api/coindcx/candles does for crypto. Requires
// an active Zerodha login (kiteInstance with a valid access token) — there's
// no public, unauthenticated equivalent of CoinDCX's candles endpoint.
app.get("/api/zerodha/candles", async (req: Request, res: Response) => {
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

// CoinDCX Polling Proxy (CoinDCX doesn't have public K-line WebSockets, so we poll their public REST API)
app.get("/api/stream/coindcx", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const activeMarkets = ['BTCINR', 'ETHINR', 'SOLINR', 'AVAXINR', 'NEARINR', 'JUPINR', 'XRPINR'];

  const pollInterval = setInterval(async () => {
    try {
      const response = await fetch('https://public.coindcx.com/exchange/ticker');
      const data: any = await response.json();
      const updates: Record<string, any> = {};

      data.forEach((ticker: any) => {
        if (activeMarkets.includes(ticker.market)) {
          // Format the symbol back to UI expectations (e.g. BTCINR -> BTC/INR)
          const formattedSym = ticker.market.endsWith('INR')
            ? ticker.market.replace('INR', '/INR')
            : ticker.market.replace('USDT', '/USDT');

          updates[formattedSym] = {
            c: parseFloat(ticker.last_price),
            h: parseFloat(ticker.high),
            l: parseFloat(ticker.low),
            v: parseFloat(ticker.volume),
            t: parseInt(ticker.timestamp) * 1000 // Convert seconds to MS
          };
        }
      });

      res.write(`data: ${JSON.stringify(updates)}\n\n`);
    } catch (e: any) {
      console.error("CoinDCX Poll Error:", e.message);
    }
  }, 2000); // Poll every 2 seconds

  req.on('close', () => {
    clearInterval(pollInterval);
    res.end();
  });
});

// Sanitize external untrusted text (Section 4 & 17: Input sanitization for external text)
function sanitizeExternalText(text: string): string {
  if (!text || typeof text !== "string") return "";
  // Strip control characters, script/html tags, normalize length
  return text
    .replace(/<[^>]*>?/gm, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .trim()
    .slice(0, 1000);
}

// Lazy Gemini client helper
let aiClient: GoogleGenAI | null = null;
function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Timeout wrapper for AI calls (Section 4 & 8: hard timeout, fail-closed)
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`AI Agent request timed out after ${timeoutMs}ms (Fail-Closed triggered)`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

// Helper to clean API error messages without dumping raw JSON strings
function cleanErrorMessage(rawMsg: string): string {
  if (!rawMsg) return "Service temporarily unavailable";
  try {
    const parsed = typeof rawMsg === "string" && rawMsg.startsWith("{") ? JSON.parse(rawMsg) : null;
    if (parsed?.error?.message) {
      return `${parsed.error.message} (Code ${parsed.error.code || 503})`;
    }
  } catch {
    // fallback regex extraction
    const match = rawMsg.match(/"message":\s*"([^"]+)"/);
    if (match && match[1]) return match[1];
  }
  return rawMsg.replace(/[\n\r]/g, " ").slice(0, 160);
}

// Circuit breaker for Quota / Rate Limits to prevent repeated failures
let quotaCooldownUntil = 0;
function isQuotaExhaustedError(err: any): boolean {
  const msg = (err?.message || "").toLowerCase();
  const status = err?.status || err?.statusCode || err?.code;
  return (
    status === 429 ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("rate-limit") ||
    msg.includes("resource_exhausted") ||
    msg.includes("exceeded your current quota")
  );
}

// Resilient AI generation with automatic multi-model fallback and quota circuit breaker
async function executeResilientAiGeneration(params: {
  contents: string;
  responseSchema?: any;
  timeoutMs?: number;
}): Promise<{ data: any; modelUsed: string; isAi: boolean }> {
  const ai = getAiClient();
  if (!ai) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  // If quota is currently in cooldown, skip API call and trigger deterministic fallback immediately
  if (Date.now() < quotaCooldownUntil) {
    throw new Error("QUOTA_COOLDOWN_ACTIVE");
  }

  // Model cascade: try primary first, fallback to lightweight model
  const modelsToTry = ["gemini-3.8-flash", "gemini-3.1-flash-lite"];
  let lastError: any = null;

  for (const model of modelsToTry) {
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model,
          contents: params.contents,
          config: {
            responseMimeType: "application/json",
            responseSchema: params.responseSchema,
          },
        }),
        params.timeoutMs || 4500
      );

      const text = response?.text;
      if (text) {
        const parsed = JSON.parse(text);
        return { data: parsed, modelUsed: model, isAi: true };
      }
    } catch (err: any) {
      lastError = err;
      if (isQuotaExhaustedError(err)) {
        // Activate 60s quota cooldown to prevent spamming exhausted quota
        quotaCooldownUntil = Date.now() + 60000;
        break;
      }
    }
  }

  throw lastError || new Error("All AI models currently busy or unreachable");
}

// CoinDCX Credential Resolver: extracts API key and secret from headers, body, or server env
function getCoinDcxCredentials(req: Request): { apiKey: string; apiSecret: string } {
  const headerKey = (req.headers["x-coindcx-apikey"] || req.headers["x-auth-apikey"]) as string | undefined;
  const headerSecret = (req.headers["x-coindcx-apisecret"] || req.headers["x-auth-apisecret"]) as string | undefined;
  const bodyKey = (req.body?.apiKey) as string | undefined;
  const bodySecret = (req.body?.apiSecret) as string | undefined;
  const queryKey = (req.query?.apiKey) as string | undefined;
  const querySecret = (req.query?.apiSecret) as string | undefined;

  const apiKey = (headerKey || bodyKey || queryKey || process.env.COINDCX_API_KEY || "").trim();
  const apiSecret = (headerSecret || bodySecret || querySecret || process.env.COINDCX_API_SECRET || "").trim();
  return { apiKey, apiSecret };
}

// Reusable CoinDCX balance fetcher & validator
const handleCoinDcxBalances = async (req: Request, res: Response) => {
  try {
    const { apiKey, apiSecret } = getCoinDcxCredentials(req);

    if (!apiKey || !apiSecret) {
      return res.status(401).json({
        success: false,
        error: "Missing CoinDCX API credentials. Please configure HMAC Key & Secret in the Risk & Safety Console.",
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
      keyMasked: apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : "ACTIVE",
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("[CoinDCX Balances] Network error:", error);
    return res.status(500).json({ success: false, error: error?.message || "Network error fetching CoinDCX balance" });
  }
};

app.get("/api/coindcx/balances", handleCoinDcxBalances);
app.post("/api/coindcx/balances", handleCoinDcxBalances);

// Explicit HMAC credentials validation endpoint
app.post("/api/coindcx/validate-keys", async (req: Request, res: Response) => {
  return handleCoinDcxBalances(req, res);
});

// CoinDCX Order Cancellation endpoint
app.post("/api/coindcx/orders/cancel", async (req: Request, res: Response) => {
  try {
    const { apiKey, apiSecret } = getCoinDcxCredentials(req);
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: "Order ID required for cancellation" });
    }

    if (!apiKey || !apiSecret) {
      return res.status(401).json({ success: false, error: "Missing CoinDCX API credentials" });
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

app.get("/api/coindcx/ticker", async (req, res) => {
  try {
    const response = await fetch('https://public.coindcx.com/exchange/ticker');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch from CoinDCX" });
  }
});

// Real historical candles, proxied from CoinDCX's public candles API
// (https://public.coindcx.com/market_data/candles) — used for the
// higher-timeframe (1h) confluence check, so that check is grounded in
// CoinDCX's own real historical data rather than synthetic backfill.
app.get("/api/coindcx/candles", async (req, res) => {
  try {
    const { symbol, interval, limit } = req.query;
    if (!symbol || typeof symbol !== "string") {
      return res.status(400).json({ error: "symbol query param required, e.g. XRP" });
    }

    const pair = `I-${symbol}_INR`;
    const url = `https://public.coindcx.com/market_data/candles?pair=${pair}&interval=${interval || "1h"}&limit=${limit || 100}`;
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

// CoinDCX Authenticated Trade Execution Route
app.post("/api/execute-trade", async (req, res) => {
  const { symbol, side, quantity, price, orderType, isPaperTrade, confirmLiveOrder, maxSlippagePct } = req.body;
  const { apiKey, apiSecret } = getCoinDcxCredentials(req);

  // Fail-safe default: a request only goes live if isPaperTrade is exactly
  // `false` AND confirmLiveOrder is exactly `true`. Anything else — missing,
  // undefined, malformed — stays paper. Ambiguous input should never resolve
  // to "spend real money," following the fail-closed principle.
  const wantsLiveOrder = isPaperTrade === false && confirmLiveOrder === true;

  if (!wantsLiveOrder) {
    // Model realistic paper trading slippage (0.02% to 0.08%) against the order book
    const slippageFactor = (Math.random() * 0.0006) + 0.0002;
    const isBuy = side === "LONG" || side === "buy";
    const simulatedFillPrice = Number(
      (isBuy ? price * (1 + slippageFactor) : price * (1 - slippageFactor)).toFixed(4)
    );
    const slippageCost = Number(Math.abs(simulatedFillPrice - price) * quantity).toFixed(2);

    return res.json({
      success: true,
      mode: "PAPER",
      message: "PAPER TRADE: Execution simulated locally with slippage model.",
      orderId: "paper_" + Date.now(),
      executedPrice: simulatedFillPrice,
      quotedPrice: price,
      slippagePercent: Number((slippageFactor * 100).toFixed(3)),
      slippageCost,
      timestamp: new Date().toISOString()
    });
  }

  // LIVE ORDER VALIDATION
  if (!apiKey || !apiSecret) {
    return res.status(401).json({
      success: false,
      error: "Missing CoinDCX API Keys. Configure HMAC keys in Risk & Safety Console before live execution.",
      code: "MISSING_KEYS"
    });
  }

  try {
    const timestamp = Math.floor(Date.now());
    // Format market pair for CoinDCX: e.g. "BTC/INR" -> "BTCINR", "B-BTC_INR" -> "BTCINR"
    const cleanMarket = symbol.replace("/", "").replace(/-/g, "").replace(/_/g, "");
    
    // CoinDCX side is "buy" or "sell"
    const orderSide = (side === "LONG" || side === "buy") ? "buy" : "sell";
    // CoinDCX order_type is "market_order" or "limit_order"
    const cdcxOrderType = (orderType === "MARKET" || !price) ? "market_order" : "limit_order";

    const body: Record<string, any> = {
      side: orderSide,
      order_type: cdcxOrderType,
      market: cleanMarket,
      total_quantity: Number(quantity),
      timestamp: timestamp,
      client_order_id: `nx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    };

    if (cdcxOrderType !== "market_order" && price) {
      body.price_per_unit = Number(price);
    }

    const payload = JSON.stringify(body);
    const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');

    const cdcxResponse = await fetch('https://api.coindcx.com/exchange/v1/orders/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-APIKEY': apiKey,
        'X-AUTH-SIGNATURE': signature
      },
      body: payload
    });

    const data: any = await cdcxResponse.json();

    if (!cdcxResponse.ok) {
      return res.status(cdcxResponse.status).json({
        success: false,
        error: data?.message || `CoinDCX rejected order (${cdcxResponse.status})`,
        cdcxResponse: data
      });
    }

    const exchangeOrderId = data?.orders?.[0]?.id || data?.id || ("cdcx_" + Date.now());
    const executedPrice = data?.orders?.[0]?.price_per_unit || price;

    return res.json({
      success: true,
      mode: "LIVE",
      message: "LIVE TRADE: Order dispatched & accepted by CoinDCX Exchange.",
      orderId: exchangeOrderId,
      executedPrice: Number(executedPrice),
      cdcxResponse: data,
      timestamp: new Date().toISOString()
    });
  } catch (e: any) {
    console.error("[CoinDCX Order Dispatch] Error:", e);
    return res.status(500).json({ success: false, error: e.message || "Failed to dispatch order to CoinDCX" });
  }
});

// ==========================================
// SERVER-SIDE 24/7 POSITION GUARDIAN DAEMON
// ==========================================
// Keeps monitoring trailing stops, take-profit, stop-loss, and max holding time
// even when the browser is asleep, minimized, or closed.

export interface DaemonPosition {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  highestPrice?: number;
  lowestPrice?: number;
  trailActive?: boolean;
  atrAtEntry?: number;
  trailMode?: "SCALP_TIGHT" | "TREND_RUNNER";
  openTime: string;
  expectedHoldingTimeMinutes?: number;
  isSelfApproved?: boolean;
  setupName?: string;
  userId?: string;
}

export interface DaemonClosedTrade {
  id: string;
  positionId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  moneyPlaced: number;
  grossPnl: number;
  feesPaid: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  isWin: boolean;
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "EXPIRY_TIME" | "MANUAL";
  closedAt: string;
  openedAt: string;
  holdingDurationMinutes?: number;
  setupName?: string;
}

interface DaemonPersistedState {
  version: number;
  lastUpdated: string;
  positions: DaemonPosition[];
  closedTrades: DaemonClosedTrade[];
}

// Persistent daemon state configuration on disk
const DAEMON_STORAGE_DIR = path.join(process.cwd(), "data");
const DAEMON_STORAGE_FILE = path.join(DAEMON_STORAGE_DIR, "daemon_positions_state.json");
const DAEMON_STORAGE_TMP = path.join(DAEMON_STORAGE_DIR, "daemon_positions_state.json.tmp");

// In-memory server daemon registry of active positions synced with clients
const daemonPositions: Map<string, DaemonPosition> = new Map();
const daemonClosedTrades: DaemonClosedTrade[] = [];
let daemonLastSavedAt: string = new Date().toISOString();
let daemonSaveTimer: NodeJS.Timeout | null = null;

// Synchronous disk save with atomic write (.tmp -> rename)
function saveDaemonStateToDisk(): void {
  try {
    if (!fs.existsSync(DAEMON_STORAGE_DIR)) {
      fs.mkdirSync(DAEMON_STORAGE_DIR, { recursive: true });
    }
    const state: DaemonPersistedState = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      positions: Array.from(daemonPositions.values()),
      closedTrades: daemonClosedTrades.slice(0, 200),
    };
    daemonLastSavedAt = state.lastUpdated;
    fs.writeFileSync(DAEMON_STORAGE_TMP, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(DAEMON_STORAGE_TMP, DAEMON_STORAGE_FILE);
  } catch (err) {
    console.error("[Daemon Persistence] Error saving daemon state to disk:", err);
  }
}

// Debounced disk save for frequent price updates
function scheduleDaemonDiskSave(delayMs: number = 3000): void {
  if (daemonSaveTimer) return;
  daemonSaveTimer = setTimeout(() => {
    daemonSaveTimer = null;
    saveDaemonStateToDisk();
  }, delayMs);
}

// Hydrate state from disk on boot to achieve crash recovery
function loadDaemonStateFromDisk(): void {
  try {
    if (fs.existsSync(DAEMON_STORAGE_FILE)) {
      const raw = fs.readFileSync(DAEMON_STORAGE_FILE, "utf8");
      if (raw && raw.trim().length > 0) {
        const state: DaemonPersistedState = JSON.parse(raw);
        if (Array.isArray(state.positions)) {
          const now = Date.now();
          for (const pos of state.positions) {
            if (pos && pos.id && pos.symbol && pos.entryPrice) {
              // Sanity check: Check if position holding time expired during downtime
              const openedMs = pos.openTime ? new Date(pos.openTime).getTime() : now;
              const elapsedMinutes = (now - openedMs) / 60000;
              const limitMinutes = pos.expectedHoldingTimeMinutes || 30;
              if (elapsedMinutes >= limitMinutes) {
                console.log(`[Daemon Crash Recovery] Restored position ${pos.id} (${pos.symbol}) expired during downtime. Auto-closing on recovery.`);
                daemonPositions.set(pos.id, pos);
                executeDaemonExit(pos, pos.currentPrice || pos.entryPrice, "EXPIRY_TIME");
              } else {
                daemonPositions.set(pos.id, pos);
              }
            }
          }
        }
        if (Array.isArray(state.closedTrades)) {
          for (const trade of state.closedTrades) {
            if (trade && trade.id) {
              daemonClosedTrades.push(trade);
            }
          }
        }
        console.log(
          `[Daemon Crash Recovery] ⚡ Restored ${daemonPositions.size} open position(s) and ${daemonClosedTrades.length} closed trade event(s) from persistent disk storage! Guardian active immediately upon boot.`
        );
      }
    } else {
      console.log("[Daemon Crash Recovery] No previous state file found on disk. Initializing fresh guardian state.");
    }
  } catch (err) {
    console.error("[Daemon Crash Recovery] Failed to restore daemon state from disk:", err);
  }
}

// Run state restoration immediately on server start
loadDaemonStateFromDisk();

// Graceful process exit flushes
process.on("SIGTERM", () => {
  console.log("[Daemon] SIGTERM received. Flushing state to disk...");
  saveDaemonStateToDisk();
});
process.on("SIGINT", () => {
  console.log("[Daemon] SIGINT received. Flushing state to disk...");
  saveDaemonStateToDisk();
});

// Comprehensive daemon state inspector & recovery diagnostics
app.get("/api/daemon/state", (_req: Request, res: Response) => {
  res.json({
    success: true,
    status: "ACTIVE",
    trackedCount: daemonPositions.size,
    activePositions: Array.from(daemonPositions.values()),
    closedEventsCount: daemonClosedTrades.length,
    recentClosedTrades: daemonClosedTrades.slice(0, 50),
    persistedStorage: "READY",
    storageFilePath: DAEMON_STORAGE_FILE,
    lastSavedAt: daemonLastSavedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Sync positions from client to server daemon
app.post("/api/daemon/sync-positions", (req: Request, res: Response) => {
  const { positions } = req.body;
  if (!Array.isArray(positions)) {
    return res.status(400).json({ error: "positions array required" });
  }

  const incomingIds = new Set(positions.map((p: DaemonPosition) => p.id));
  
  // Set of closed position IDs to prevent ghost resurrection of positions closed by server
  const closedPositionIds = new Set(daemonClosedTrades.map(t => t.positionId));
  const rejectedResurrections: string[] = [];

  // Remove positions that the client explicitly closed
  for (const id of daemonPositions.keys()) {
    if (!incomingIds.has(id)) {
      daemonPositions.delete(id);
    }
  }

  // Update or insert current positions
  for (const p of positions) {
    if (closedPositionIds.has(p.id)) {
      rejectedResurrections.push(p.id);
      continue;
    }

    const existing = daemonPositions.get(p.id);
    daemonPositions.set(p.id, {
      ...p,
      highestPrice: existing?.highestPrice ? Math.max(existing.highestPrice, p.highestPrice || p.entryPrice) : (p.highestPrice || p.entryPrice),
      lowestPrice: existing?.lowestPrice ? Math.min(existing.lowestPrice, p.lowestPrice || p.entryPrice) : (p.lowestPrice || p.entryPrice),
      trailActive: existing?.trailActive ?? p.trailActive ?? false,
      stopLoss: existing?.stopLoss ?? p.stopLoss,
    });
  }

  // Persist updated positions immediately to disk
  saveDaemonStateToDisk();

  res.json({
    success: true,
    trackedCount: daemonPositions.size,
    closedEventsCount: daemonClosedTrades.length,
    rejectedResurrections,
    lastSavedAt: daemonLastSavedAt,
  });
});

// Client pulls closed events that occurred server-side while client was asleep
app.get("/api/daemon/closed-events", (req: Request, res: Response) => {
  const since = req.query.since ? Number(req.query.since) : 0;
  // If since is 0 or negative, return recent events up to 50
  const events = since > 0
    ? daemonClosedTrades.filter(t => new Date(t.closedAt).getTime() > since)
    : daemonClosedTrades.slice(0, 50);
  res.json({
    success: true,
    events,
    activePositions: Array.from(daemonPositions.values()),
    lastSavedAt: daemonLastSavedAt
  });
});

// Process a server-side position exit
function executeDaemonExit(pos: DaemonPosition, exitPrice: number, reason: "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "EXPIRY_TIME") {
  if (!daemonPositions.has(pos.id)) return;
  daemonPositions.delete(pos.id);

  const isLong = pos.direction === "LONG";
  const diff = isLong ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
  const rawGrossPnl = Number((diff * pos.quantity).toFixed(2));

  // CoinDCX Futures fee schedule: 0.02% maker TP / 0.05% taker stop/market
  const entryNotional = pos.entryPrice * pos.quantity;
  const exitNotional = exitPrice * pos.quantity;
  const isCloseMaker = reason === "TAKE_PROFIT";
  const openFeeRate = 0.0005;
  const closeFeeRate = isCloseMaker ? 0.0002 : 0.0005;
  const totalFeesPaid = Number((entryNotional * openFeeRate + exitNotional * closeFeeRate).toFixed(2));
  const finalPnl = Number((rawGrossPnl - totalFeesPaid).toFixed(2));
  const pnlPercent = Number(((finalPnl / entryNotional) * 100).toFixed(2));
  const isWin = finalPnl >= 0;

  const exitTimeMs = Date.now();
  const openTimeMs = pos.openTime ? new Date(pos.openTime).getTime() : exitTimeMs;
  const holdingDurationMinutes = Math.max(1, Math.round((exitTimeMs - openTimeMs) / 60000));

  const closedRecord: DaemonClosedTrade = {
    id: `daemon-closed-${exitTimeMs}-${pos.id}`,
    positionId: pos.id,
    symbol: pos.symbol,
    direction: pos.direction,
    entryPrice: pos.entryPrice,
    exitPrice,
    quantity: pos.quantity,
    moneyPlaced: entryNotional,
    grossPnl: rawGrossPnl,
    feesPaid: totalFeesPaid,
    realizedPnl: finalPnl,
    realizedPnlPercent: pnlPercent,
    isWin,
    exitReason: reason,
    closedAt: new Date(exitTimeMs).toISOString(),
    openedAt: pos.openTime,
    holdingDurationMinutes,
    setupName: pos.setupName || "Statistical Trailing System",
  };

  daemonClosedTrades.unshift(closedRecord);
  if (daemonClosedTrades.length > 200) daemonClosedTrades.pop();

  // Save to disk immediately upon any trade exit
  saveDaemonStateToDisk();

  console.log(`[Daemon Position Guardian] Auto-closed ${pos.symbol} (${pos.direction}) @ ${exitPrice} | Reason: ${reason} | PnL: ₹${finalPnl}`);

  // Broadcast exit immediately to any connected WebSocket clients
  if (globalWss) {
    globalWss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "DAEMON_POSITION_CLOSED",
          data: closedRecord
        }));
      }
    });
  }
}

// Evaluate all daemon positions against the latest price tick
function evaluateDaemonPositions(symbol: string, currentPrice: number) {
  if (daemonPositions.size === 0) return;

  for (const pos of daemonPositions.values()) {
    if (pos.symbol !== symbol) continue;

    const isLong = pos.direction === "LONG";
    pos.currentPrice = currentPrice;

    if (!pos.highestPrice) pos.highestPrice = pos.entryPrice;
    if (!pos.lowestPrice) pos.lowestPrice = pos.entryPrice;

    if (currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;
    if (currentPrice < pos.lowestPrice) pos.lowestPrice = currentPrice;

    const entryPrice = pos.entryPrice;
    const atr = pos.atrAtEntry || entryPrice * 0.005;

    let hitExit = false;
    let exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "EXPIRY_TIME" | null = null;
    let exitFillPrice = currentPrice;

    if (isLong) {
      const peakGain = pos.highestPrice - entryPrice;
      const profitPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      const profitInATR = peakGain / (atr || 1);
      const targetDist = Math.max(0.0001, pos.takeProfit - entryPrice);
      const targetProgress = peakGain / targetDist;

      if (pos.trailMode === "TREND_RUNNER") {
        if (!pos.trailActive && (profitInATR >= 1.2 || targetProgress >= 0.50)) {
          pos.trailActive = true;
        }
        if (pos.trailActive) {
          const step1DynamicStop = Math.max(entryPrice * 1.002, pos.highestPrice - 1.5 * atr);
          if (step1DynamicStop > pos.stopLoss) pos.stopLoss = step1DynamicStop;
        }
      } else {
        if (!pos.trailActive && (profitPct >= 0.60 || profitInATR >= 1.0 || targetProgress >= 0.40)) {
          pos.trailActive = true;
        }
        if (pos.trailActive) {
          const breakevenFloor = entryPrice * 1.0018;
          let ratchetGain = entryPrice * 0.0018;
          if (profitInATR >= 1.8 || targetProgress >= 0.75) {
            ratchetGain = Math.max(ratchetGain, peakGain * 0.70);
          } else if (profitInATR >= 1.0 || targetProgress >= 0.50) {
            ratchetGain = Math.max(ratchetGain, peakGain * 0.50);
          }
          const dynamicStop = Math.max(breakevenFloor, entryPrice + ratchetGain);
          if (dynamicStop > pos.stopLoss) pos.stopLoss = dynamicStop;
        }
      }

      if (currentPrice >= pos.takeProfit) {
        hitExit = true;
        exitReason = "TAKE_PROFIT";
      } else if (currentPrice <= pos.stopLoss) {
        hitExit = true;
        exitReason = pos.trailActive || pos.stopLoss >= entryPrice ? "TRAILING_STOP" : "STOP_LOSS";
      }
    } else {
      // Short
      const peakGain = entryPrice - pos.lowestPrice;
      const profitPct = ((entryPrice - currentPrice) / entryPrice) * 100;
      const profitInATR = peakGain / (atr || 1);
      const targetDist = Math.max(0.0001, entryPrice - pos.takeProfit);
      const targetProgress = peakGain / targetDist;

      if (pos.trailMode === "TREND_RUNNER") {
        if (!pos.trailActive && (profitInATR >= 1.2 || targetProgress >= 0.50)) {
          pos.trailActive = true;
        }
        if (pos.trailActive) {
          const step1DynamicStop = Math.min(entryPrice * 0.998, pos.lowestPrice + 1.5 * atr);
          if (step1DynamicStop < pos.stopLoss) pos.stopLoss = step1DynamicStop;
        }
      } else {
        if (!pos.trailActive && (profitPct >= 0.60 || profitInATR >= 1.0 || targetProgress >= 0.40)) {
          pos.trailActive = true;
        }
        if (pos.trailActive) {
          const breakevenCeiling = entryPrice * 0.9982;
          let ratchetGain = entryPrice * 0.0018;
          if (profitInATR >= 1.8 || targetProgress >= 0.75) {
            ratchetGain = Math.max(ratchetGain, peakGain * 0.70);
          } else if (profitInATR >= 1.0 || targetProgress >= 0.50) {
            ratchetGain = Math.max(ratchetGain, peakGain * 0.50);
          }
          const dynamicStop = Math.min(breakevenCeiling, entryPrice - ratchetGain);
          if (dynamicStop < pos.stopLoss) pos.stopLoss = dynamicStop;
        }
      }

      if (currentPrice <= pos.takeProfit) {
        hitExit = true;
        exitReason = "TAKE_PROFIT";
      } else if (currentPrice >= pos.stopLoss) {
        hitExit = true;
        exitReason = pos.trailActive || pos.stopLoss <= entryPrice ? "TRAILING_STOP" : "STOP_LOSS";
      }
    }

    if (hitExit && exitReason) {
      executeDaemonExit(pos, exitFillPrice, exitReason);
    } else {
      // Ratchet or price moved without exit — keep disk state fresh in background
      scheduleDaemonDiskSave(3000);
    }
  }
}

// 24/7 Background Expiry Guard: checks max holding time every 15s even if no ticks arrive
setInterval(() => {
  const now = Date.now();
  for (const pos of daemonPositions.values()) {
    const openedMs = pos.openTime ? new Date(pos.openTime).getTime() : now;
    const elapsedMinutes = (now - openedMs) / 60000;
    const limitMinutes = pos.expectedHoldingTimeMinutes || 30;
    if (elapsedMinutes >= limitMinutes) {
      executeDaemonExit(pos, pos.currentPrice || pos.entryPrice, "EXPIRY_TIME");
    }
  }
}, 15000);

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    version: "2.0",
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

// 2. Market Analysis Agent endpoint
app.post("/api/agent/market-analysis", async (req: Request, res: Response) => {
  const { symbol, timeframe, price, indicators, simulateTimeout, recentSwingHigh, recentSwingLow } = req.body;

  if (simulateTimeout) {
    // Failure injection simulation for Section 8 & 17
    setTimeout(() => {
      res.status(200).json({
        regime: "high_volatility_choppy",
        trendStrength: 15,
        volatilityState: "elevated",
        keySupport: Number(((price || 100) * 0.98).toFixed(2)),
        keyResistance: Number(((price || 100) * 1.02).toFixed(2)),
        regimeSummary: "Simulated AI agent timeout -> Fail-Closed default enforced: AVOID.",
        tradingRecommendation: "AVOID",
        decision: "NO_TRADE",
        failClosed: true,
        modelUsed: "Simulated Timeout (Fail-Closed)",
        isAiGenerated: false,
      });
    }, 1200);
    return;
  }

  // Real recent swing high/low, when the caller has them (computed from
  // actual bars) — grounds support/resistance in real market structure
  // instead of asking the model to invent levels from a bare price number.
  // These are also used to OVERRIDE whatever numeric levels come back
  // below, so accuracy doesn't depend on the model reading them correctly.
  const hasSwingData = typeof recentSwingHigh === "number" && typeof recentSwingLow === "number";
  const swingContext = hasSwingData
    ? `- Recent swing high (structure resistance): ${recentSwingHigh}\n- Recent swing low (structure support): ${recentSwingLow}`
    : `- No recent swing-price history was provided; do not assert specific support/resistance levels with confidence.`;

  const prompt = `You are the Market Analysis Agent for a statistical trading bot (v2.0).
Analyze the following market conditions for ${symbol || "NIFTY"} (${timeframe || "5m"}):
- Current Price: ${price}
- Indicators: ${JSON.stringify(indicators)}
${swingContext}

Base keySupport/keyResistance on the recent swing high/low above when provided, not a generic percentage band.

Provide a strict technical and regime assessment in JSON format:
{
  "regime": "trending_bullish" | "trending_bearish" | "ranging_tight" | "ranging_wide" | "high_volatility_choppy",
  "trendStrength": number between 0 and 100,
  "volatilityState": "low" | "moderate" | "elevated" | "extreme",
  "keySupport": number,
  "keyResistance": number,
  "regimeSummary": "concise 1-2 sentence description",
  "tradingRecommendation": "TRADE_FAVORED" | "CAUTION" | "AVOID"
}`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      regime: { type: Type.STRING },
      trendStrength: { type: Type.NUMBER },
      volatilityState: { type: Type.STRING },
      keySupport: { type: Type.NUMBER },
      keyResistance: { type: Type.NUMBER },
      regimeSummary: { type: Type.STRING },
      tradingRecommendation: { type: Type.STRING },
    },
    required: ["regime", "trendStrength", "volatilityState", "keySupport", "keyResistance", "regimeSummary", "tradingRecommendation"],
  };

  try {
    const result = await executeResilientAiGeneration({
      contents: prompt,
      responseSchema,
      timeoutMs: 4500,
    });

    return res.json({
      ...result.data,
      // Real structure overrides the model's numeric guess whenever we have it.
      ...(hasSwingData ? { keySupport: recentSwingLow, keyResistance: recentSwingHigh } : {}),
      modelUsed: result.modelUsed,
      isAiGenerated: true,
      failClosed: false,
    });
  } catch (err: any) {
    const isQuota = isQuotaExhaustedError(err) || err?.message === "QUOTA_COOLDOWN_ACTIVE";
    const cleanMsg = isQuota ? "Quota limit active (Deterministic safety engaged)" : cleanErrorMessage(err?.message || "");
    if (!isQuota) {
      console.info(`[Market Analysis Agent] Deterministic fallback: ${cleanMsg}`);
    }

    // Section 4 & 8 Deterministic Fail-Closed Rule
    const rsi = indicators?.rsi || 50;
    const adx = indicators?.adx || 20;
    const regime = adx > 25 ? (rsi > 50 ? "trending_bullish" : "trending_bearish") : "ranging_wide";
    const currentPrice = Number(price) || 100;

    return res.status(200).json({
      regime,
      trendStrength: Math.round(adx),
      volatilityState: indicators?.atrPercent > 1.5 ? "elevated" : "moderate",
      // Real swing structure when available; otherwise the old percentage-band
      // guess, clearly a fallback rather than passed off as precise.
      keySupport: hasSwingData ? recentSwingLow : Number((currentPrice * 0.985).toFixed(2)),
      keyResistance: hasSwingData ? recentSwingHigh : Number((currentPrice * 1.015).toFixed(2)),
      regimeSummary: `Fail-Closed Deterministic Protection: Technical assessment indicates ${regime} with ADX at ${Math.round(adx)} and RSI at ${Math.round(rsi)}. Guardrails enforced.`,
      tradingRecommendation: adx > 25 ? "CAUTION" : "AVOID",
      failClosed: true,
      isAiGenerated: false,
      modelUsed: "Deterministic Rule Engine (Fail-Closed)",
      errorNote: cleanMsg,
    });
  }
});

// 3. Supervisor Agent endpoint (Synthesizes setup, similarity, and risk into trade proposal)
app.post("/api/agent/supervisor-propose", async (req: Request, res: Response) => {
  const { symbol, setup, marketAnalysis, similarExperiences, rawExternalNews, simulateTimeout } = req.body;

  if (simulateTimeout) {
    // Failure injection: timeout defaults to NO TRADE
    return res.status(200).json({
      decision: "NO_TRADE",
      confidence: 0,
      metaConfidenceScore: 0,
      reasoning: "AI Agent timed out in live decision path -> Fail-Closed default enforced: NO TRADE.",
      confidenceRationale: "Fail-Closed safety triggered by simulated timeout.",
      failureConditionRisk: "Timeout latency threshold breached (>1500ms).",
      expectedHoldingTimeMinutes: 0,
      executiveSummary: "AI agent timeout simulated; strict safety policy enforced NO_TRADE.",
      failClosed: true,
      modelUsed: "Simulated Timeout (Fail-Closed)",
      isAiGenerated: false,
    });
  }

  const sanitizedNews = sanitizeExternalText(rawExternalNews || "");

  const prompt = `You are the Supervisor Agent in a v2.0 Trading Bot.
You synthesize technical setup candidate, regime context, and historical experiences into a formal proposal.
IMPORTANT: You CANNOT override deterministic risk rules.

Candidate Setup:
- Symbol: ${symbol}
- Strategy: ${setup?.name} (Direction: ${setup?.direction})
- Entry Price: ${setup?.entryPrice}, Stop Loss: ${setup?.stopLoss}, Take Profit: ${setup?.takeProfit}
- Market Context: ${JSON.stringify(marketAnalysis)}
- Historical Similarity (${similarExperiences?.length || 0} setups):
${JSON.stringify(similarExperiences)}
- Sanitized External Context: "${sanitizedNews}"

Evaluate whether this setup should be submitted as a Trade Proposal or NO_TRADE.
Return JSON format:
{
  "decision": "TRADE" | "NO_TRADE",
  "metaConfidenceScore": number between 0 and 1,
  "confidenceRationale": "Explanation of trust in this specific setup instance",
  "failureConditionRisk": "Identified risks or historical failure traps",
  "expectedHoldingTimeMinutes": number,
  "executiveSummary": "Concise 2-sentence rationale"
}`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      decision: { type: Type.STRING },
      metaConfidenceScore: { type: Type.NUMBER },
      confidenceRationale: { type: Type.STRING },
      failureConditionRisk: { type: Type.STRING },
      expectedHoldingTimeMinutes: { type: Type.NUMBER },
      executiveSummary: { type: Type.STRING },
    },
    required: ["decision", "metaConfidenceScore", "confidenceRationale", "failureConditionRisk", "expectedHoldingTimeMinutes", "executiveSummary"],
  };

  try {
    const result = await executeResilientAiGeneration({
      contents: prompt,
      responseSchema,
      timeoutMs: 4500,
    });

    return res.json({
      ...result.data,
      modelUsed: result.modelUsed,
      isAiGenerated: true,
      failClosed: false,
    });
  } catch (err: any) {
    const isQuota = isQuotaExhaustedError(err) || err?.message === "QUOTA_COOLDOWN_ACTIVE";
    const cleanMsg = isQuota ? "Quota limit active (Deterministic safety engaged)" : cleanErrorMessage(err?.message || "");
    if (!isQuota) {
      console.info(`[Supervisor Agent] Deterministic fallback: ${cleanMsg}`);
    }

    // Strict Fail-Closed default
    const winRate = setup?.historicalWinRate || 0.55;
    const qualifies = setup?.qualifies && winRate >= 0.54;

    return res.status(200).json({
      decision: qualifies ? "TRADE" : "NO_TRADE",
      metaConfidenceScore: qualifies ? Number(winRate.toFixed(2)) : 0,
      confidenceRationale: `Deterministic Fallback: Evaluated historical win-rate ${(winRate * 100).toFixed(0)}% against regime filters.`,
      failureConditionRisk: "Adverse market volatility or thin limit liquidity in current regime.",
      expectedHoldingTimeMinutes: qualifies ? 45 : 0,
      executiveSummary: qualifies
        ? `Deterministic rule qualified setup ${setup?.name} with ${(winRate * 100).toFixed(0)}% statistical win-rate.`
        : "Agent safety lock active: deterministic risk engine enforced NO_TRADE.",
      failClosed: !qualifies,
      isAiGenerated: false,
      modelUsed: "Deterministic Rule Engine (Fail-Closed)",
      errorNote: cleanMsg,
    });
  }
});

// 4. Trade Autopsy Agent endpoint (Section 10: Post-trade autopsy & learning dataset)
app.post("/api/agent/trade-autopsy", async (req: Request, res: Response) => {
  const { trade } = req.body;

  const prompt = `You are the Trade Autopsy Agent in a v2.0 Trading Bot.
Perform a structured post-mortem for the following completed trade:
${JSON.stringify(trade, null, 2)}

Provide post-trade classification and learning feedback.
Classification MUST be one of:
- "good_decision_good_outcome" (Process sound, outcome profitable)
- "good_decision_bad_outcome" (Process sound, took normal loss within edge)
- "bad_decision_good_outcome" (Flawed entry/rules broken, saved by luck)
- "bad_decision_bad_outcome" (Flawed entry/rules broken, lost money)

Return JSON:
{
  "classification": "good_decision_good_outcome" | "good_decision_bad_outcome" | "bad_decision_good_outcome" | "bad_decision_bad_outcome",
  "rootCause": "Detailed root cause of trade result",
  "recurringConditions": ["list", "of", "conditions", "present"],
  "learningTags": ["tag1", "tag2", "tag3"],
  "metaModelCalibrationDelta": number between -0.2 and 0.2 (adjustment to future confidence under these conditions),
  "autopsySummary": "1-2 sentence crisp takeaway"
}`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      classification: { type: Type.STRING },
      rootCause: { type: Type.STRING },
      recurringConditions: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      learningTags: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      metaModelCalibrationDelta: { type: Type.NUMBER },
      autopsySummary: { type: Type.STRING },
    },
    required: ["classification", "rootCause", "recurringConditions", "learningTags", "metaModelCalibrationDelta", "autopsySummary"],
  };

  try {
    const result = await executeResilientAiGeneration({
      contents: prompt,
      responseSchema,
      timeoutMs: 4500,
    });

    return res.json({
      ...result.data,
      modelUsed: result.modelUsed,
      isAiGenerated: true,
    });
  } catch (err: any) {
    if (!isQuotaExhaustedError(err) && err?.message !== "QUOTA_COOLDOWN_ACTIVE") {
      const cleanMsg = cleanErrorMessage(err?.message || "");
      console.info(`[Trade Autopsy Agent] Deterministic fallback: ${cleanMsg}`);
    }

    const isWin = (trade?.realizedPnl || trade?.pnl || 0) > 0;
    const classification = isWin ? "good_decision_good_outcome" : "good_decision_bad_outcome";
    const pnlVal = Number(trade?.realizedPnl || trade?.pnl || 0);

    return res.json({
      classification,
      rootCause: isWin
        ? "Setup confirmed with momentum expansion reaching profit target."
        : "Target not reached within expected horizon; stopped out cleanly according to risk rules.",
      recurringConditions: [trade?.regime || "trending", "limit_fill"],
      learningTags: [trade?.setupName || "momentum", isWin ? "win" : "loss", "calibrated"],
      metaModelCalibrationDelta: isWin ? 0.04 : -0.05,
      autopsySummary: `Autopsy logged: ${classification} with PnL ₹${pnlVal.toFixed(2)}.`,
      isAiGenerated: false,
      modelUsed: "Deterministic Autopsy Engine",
    });
  }
});

// Start server with Vite middleware in dev or static files in production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Self-Learning Trading Bot v2.0 Server running on port ${PORT}`);
  });

  // Attach WebSocket server for live Binance Ticker data
  const wss = new WebSocketServer({ server });
  globalWss = wss;

  // Cache the latest prices
  const latestPrices: Record<string, number> = {};

  // Connect to Binance live ticker stream
  // We use the same CoinDCX Polling logic for the top ticker tape

  // High-Frequency CoinDCX Socket.io Relay
  // CoinDCX's streaming server (per its published AsyncAPI spec) only
  // speaks the Socket.IO v2 wire protocol — package.json now pins
  // socket.io-client to 2.4.0 to match.
  // Public market channels must be of the form <EXCHANGE>-<BASE>_<QUOTE>@<topic> (e.g. I-BTC_INR@prices);
  // a bare "I-BTC_INR" with no @topic matches nothing server-side.
  const dcxSocket = io("wss://stream.coindcx.com", {
    transports: ["websocket"],
    reconnection: true
  });

  function normalizeCoinDCXSymbol(s: string) {
    let sym = s.replace(/^[A-Za-z]+-/, ''); // strip exchange prefix: I-, B-, HB-, KC-
    if (sym.includes('_')) {
      sym = sym.replace('_INR', '/INR').replace('_USDT', '/USDT').replace('_', '/');
    } else {
      sym = sym.replace('INR', '/INR').replace('USDT', '/USDT');
    }
    return sym;
  }

  const TRACKED_COINS = ['BTC', 'ETH', 'SOL', 'AVAX', 'NEAR', 'JUP', 'XRP'];
  const currentPrices: Record<string, number> = {};

  // Symbols we've had to fall back away from real data for — surfaced here
  // so it's obvious in the server log which pairs, if any, aren't actually
  // getting live CoinDCX data rather than failing silently.
  const staleSymbols = new Set<string>(TRACKED_COINS.map(c => `${c}/INR`));

  dcxSocket.on("connect", () => {
    console.log("[CoinDCX WS] connected — joining channels");
    TRACKED_COINS.forEach(sym => {
      const pair = `I-${sym}_INR`;
      dcxSocket.emit("join", { channelName: `${pair}@prices` });
      dcxSocket.emit("join", { channelName: `${pair}@trades` });
    });

    // Log once, 10s after connecting, which tracked symbols never received
    // a single real tick — the concrete symptom the "fix the currencies
    // that aren't live" ask was about.
    setTimeout(() => {
      if (staleSymbols.size > 0) {
        console.warn(`[CoinDCX WS] No real ticks received yet for: ${Array.from(staleSymbols).join(", ")}`);
      } else {
        console.log("[CoinDCX WS] Real ticks confirmed for all tracked symbols.");
      }
    }, 10000);
  });

  dcxSocket.on("connect_error", (err: any) => {
    console.error("[CoinDCX WS] connect_error:", err?.message || err);
  });

  function broadcastRealTick(rawSymbol: string, rawPrice: any, source: string) {
    const price = parseFloat(rawPrice);
    if (!rawSymbol || Number.isNaN(price)) return;
    const sym = normalizeCoinDCXSymbol(rawSymbol);
    if (!TRACKED_COINS.some(c => sym.startsWith(c))) return; // ignore pairs we don't trade

    if (staleSymbols.has(sym)) {
      console.log(`[CoinDCX WS] First real tick for ${sym} via ${source}: ${price}`);
      staleSymbols.delete(sym);
    }

    currentPrices[sym] = price;

    // Evaluate 24/7 server position guardian stops on every live tick
    evaluateDaemonPositions(sym, price);

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'TICK', data: { [sym]: price }, is24h: source === 'price-change' }));
      }
    });
  }

  dcxSocket.on("price-change", (data: any) => {
    try {
      const payload = typeof data === 'string' ? JSON.parse(data) : data;
      const inner = typeof payload.data === 'string' ? JSON.parse(payload.data) : (payload.data || payload);
      const rawSym = inner?.s || inner?.symbol || inner?.market;
      const rawPrice = inner?.p ?? inner?.c ?? inner?.price;
      if (rawSym && rawPrice !== undefined) {
        broadcastRealTick(rawSym, rawPrice, 'price-change');
      } else {
        console.warn('[CoinDCX WS] price-change payload shape unrecognized:', JSON.stringify(inner).slice(0, 200));
      }
    } catch (e) { console.warn('[CoinDCX WS] price-change parse error', e); }
  });

  dcxSocket.on("new-trade", (data: any) => {
    try {
      const payload = typeof data === 'string' ? JSON.parse(data) : data;
      const innerData = typeof payload.data === 'string' ? JSON.parse(payload.data) : payload.data;
      if (innerData && innerData.s && innerData.p) {
        broadcastRealTick(innerData.s, innerData.p, 'new-trade');
      }
    } catch(e) {}
  });
}

startServer();
