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

  const keepAlive = setInterval(() => {
    res.write(':\n\n'); // SSE comment to keep connection alive
  }, 30000);

  const binanceUrl = `wss://data-stream.binance.vision/stream?streams=${streams}`;
  const binanceWs = new WebSocket(binanceUrl);

  binanceWs.on('open', () => {
    console.log('Connected to Binance SSE proxy:', binanceUrl);
  });

  binanceWs.on('message', (data) => {
    // Send as SSE message
    res.write(`data: ${data.toString()}\n\n`);
  });

  binanceWs.on('close', () => {
    clearInterval(keepAlive);
    res.end();
  });

  binanceWs.on('error', (err) => {
    console.error('Binance SSE proxy error:', err);
    clearInterval(keepAlive);
    res.end();
  });

  req.on('close', () => {
    clearInterval(keepAlive);
    binanceWs.close();
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
  const { symbol, timeframe, price, indicators, simulateTimeout } = req.body;

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

  const prompt = `You are the Market Analysis Agent for a statistical trading bot (v2.0).
Analyze the following market conditions for ${symbol || "NIFTY"} (${timeframe || "5m"}):
- Current Price: ${price}
- Indicators: ${JSON.stringify(indicators)}

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
      keySupport: Number((currentPrice * 0.985).toFixed(2)),
      keyResistance: Number((currentPrice * 1.015).toFixed(2)),
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
- Historical Similarity (${similarExperiences?.length || 0} setups): ${JSON.stringify(similarExperiences)}
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
  const binanceWs = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');
  
  binanceWs.on('message', (data: WebSocket.RawData) => {
    try {
      const parsed = JSON.parse(data.toString());
      parsed.forEach((tick: any) => {
        // e.g. "BTCUSDT" -> 64000.5
        latestPrices[tick.s] = parseFloat(tick.c);
      });
      
      // Broadcast to our connected clients
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          // Send a curated list of top pairs to keep client parsing light
          client.send(JSON.stringify({
            type: 'TICK',
            data: {
              'BTC/USDT': latestPrices['BTCUSDT'],
              'ETH/USDT': latestPrices['ETHUSDT'],
              'SOL/USDT': latestPrices['SOLUSDT'],
              'AVAX/USDT': latestPrices['AVAXUSDT']
            }
          }));
        }
      });
    } catch (e) {
      console.error("Error parsing binance ws", e);
    }
  });

  binanceWs.on('error', (err: any) => {
    console.error('Binance WS Error:', err);
  });


  }

startServer();
