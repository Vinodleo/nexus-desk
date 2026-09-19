import io from "socket.io-client";
import crypto from "crypto";
import express, { Request, Response } from "express";
import path from "path";
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

    // Initialize Kite Ticker for live Indian Equity data
    if (kiteTickerInstance) {
      kiteTickerInstance.disconnect();
    }

    // Use the api_key and newly minted access_token
    kiteTickerInstance = new KiteTicker({
      api_key: kiteInstance.api_key,
      access_token: zerodhaAccessToken
    });

    // Hardcode some known NSE Instrument Tokens for the MVP symbols
    const instrumentMap: Record<number, string> = {
      341249: "HDFCBANK",
      738561: "RELIANCE",
      2953217: "TCS",
      779521: "SBIN"
    };

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

// 1. Health endpoint
app.get("/api/coindcx/balances", async (req, res) => {
  try {
    const apiKey = process.env.COINDCX_API_KEY;
    const apiSecret = process.env.COINDCX_API_SECRET;
    if (!apiKey || !apiSecret) {
      return res.status(401).json({ success: false, error: "Missing CoinDCX API Keys" });
    }
    const timestamp = Math.floor(Date.now());
    const body = { timestamp };
    // Same fix as /api/execute-trade: CoinDCX signs the raw JSON string,
    // not a base64 encoding of it.
    const payload = JSON.stringify(body);
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
    const data: any = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ success: false, error: data.message || "Failed to fetch balances", data });
    }
    res.json({ success: true, balances: data });
  } catch (error) {
    res.status(500).json({ success: false, error: "Network error" });
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

// CoinDCX Authenticated Trade Execution Route
app.post("/api/execute-trade", async (req, res) => {
  const { symbol, side, quantity, price, orderType, isPaperTrade, confirmLiveOrder } = req.body;
  const apiKey = process.env.COINDCX_API_KEY;
  const apiSecret = process.env.COINDCX_API_SECRET;
  if (!apiKey || !apiSecret) {
    return res.status(401).json({
      success: false,
      error: "Missing CoinDCX API Keys in Settings."
    });
  }
  // Fail-safe default: a request only goes live if isPaperTrade is exactly
  // `false` AND confirmLiveOrder is exactly `true`. Anything else — missing,
  // undefined, malformed — stays paper. Ambiguous input should never resolve
  // to "spend real money," same fail-closed principle used elsewhere in this
  // app (stale-data checks, agent timeouts).
  const wantsLiveOrder = isPaperTrade === false && confirmLiveOrder === true;
  if (!wantsLiveOrder) {
    return res.json({
      success: true,
      message: "PAPER TRADE: Execution simulated locally.",
      orderId: "paper_" + Date.now(),
      executedPrice: price
    });
  }
  try {
    const timestamp = Math.floor(Date.now());
    const body: Record<string, any> = {
      side: side === "LONG" ? "buy" : "sell",
      order_type: orderType === "MARKET" ? "market_order" : "limit_order",
      market: symbol.replace("/", ""),
      total_quantity: quantity,
      timestamp: timestamp,
    };
    if (orderType !== "MARKET") body.price_per_unit = price;
    // CoinDCX signs the raw JSON body directly, NOT a base64 encoding of it.
    // (The previous version signed base64(JSON) here, which never matches
    // what CoinDCX's server computes — same bug /api/coindcx/balances above
    // also had.)
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
        error: data?.message || "CoinDCX rejected the order.",
        cdcxResponse: data
      });
    }
    // NOTE: order-id field name is a best guess (data?.orders?.[0]?.id /
    // data?.id) — verify against CoinDCX's actual response on your first
    // real test order and adjust if the shape differs.
    return res.json({
      success: true,
      message: "LIVE TRADE: Order submitted to CoinDCX.",
      orderId: data?.orders?.[0]?.id || data?.id || ("cdcx_" + Date.now()),
      cdcxResponse: data,
      executedPrice: price
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

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
- Market Context:
${JSON.stringify(marketAnalysis)}
- Historical Similarity (${similarExperiences?.length || 0} setups):
${JSON.stringify(similarExperiences)}
- Sanitized External Context:
"${sanitizedNews}"
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
      autopsySummary: `Autopsy logged: ${classification} with PnL $${pnlVal.toFixed(2)}.`,
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
  // socket.io-client to 2.4.0 to match. Public market channels must be of
  // the form <EXCHANGE>-<BASE>_<QUOTE>@<topic> (e.g. I-BTC_INR@prices);
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
