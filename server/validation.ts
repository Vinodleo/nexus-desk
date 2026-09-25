import type { NextFunction, Request, Response } from "express";
import { z, type ZodTypeAny } from "zod";

// Request validation. Each route declares the shape it accepts; anything else
// is rejected with 400 before the handler runs. Parsed values replace
// req.body / req.query, so numeric strings etc. arrive already coerced.

export function validate(schemas: { body?: ZodTypeAny; query?: ZodTypeAny }) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const part of ["body", "query"] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: `Invalid request ${part}`,
          code: "VALIDATION_ERROR",
          issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      // Express 4 lets us replace these; the handler then sees parsed data.
      (req as unknown as Record<string, unknown>)[part] = result.data;
    }
    next();
  };
}

const positiveNumber = z.number().finite().positive();
const symbol = z.string().min(1).max(32);
const positionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, _ or -");

// ---------- trading ----------

export const executeTradeBody = z.object({
  symbol,
  side: z.enum(["LONG", "SHORT", "buy", "sell"]),
  quantity: positiveNumber,
  price: positiveNumber,
  orderType: z.enum(["MARKET", "LIMIT"]).optional(),
  // Deliberately unknown: isLiveOrderRequest() treats anything but exact
  // booleans as paper, and that must stay the single source of truth.
  isPaperTrade: z.unknown().optional(),
  confirmLiveOrder: z.unknown().optional(),
  positionId: positionId.optional(),
});

export const closePositionBody = z.object({
  positionId,
  reason: z.string().max(40).optional(),
});

// ---------- guardian ----------

const syncedPosition = z
  .object({
    id: positionId,
    symbol,
    direction: z.enum(["LONG", "SHORT"]),
    entryPrice: positiveNumber,
    quantity: positiveNumber,
    stopLoss: z.number().finite(),
    takeProfit: z.number().finite(),
    openTime: z.string().max(64),
    // Non-critical fields: a bad value is dropped rather than failing the
    // whole sync, which would stop the guardian updating every position.
    currentPrice: positiveNumber.optional().catch(undefined),
    highestPrice: positiveNumber.optional().catch(undefined),
    lowestPrice: positiveNumber.optional().catch(undefined),
    trailActive: z.boolean().optional().catch(undefined),
    atrAtEntry: z.number().finite().nonnegative().optional().catch(undefined),
    trailMode: z.enum(["SCALP_TIGHT", "TREND_RUNNER"]).optional().catch(undefined),
    expectedHoldingTimeMinutes: z.number().finite().nonnegative().optional().catch(undefined),
    initialStopLoss: positiveNumber.optional().catch(undefined),
    initialTakeProfit: positiveNumber.optional().catch(undefined),
    family: z.string().max(40).optional().catch(undefined),
    trailProfile: z.enum(["tight", "balanced", "patient", "fixed"]).optional().catch(undefined),
    partialQuantity: positiveNumber.optional().catch(undefined),
    bankedQuantity: positiveNumber.optional().catch(undefined),
    bankedPrice: positiveNumber.optional().catch(undefined),
    isSelfApproved: z.boolean().optional().catch(undefined),
    setupName: z.string().max(200).optional().catch(undefined),
  })
  // The client restores its book from what it synced, so keep its other
  // display fields; the guardian only reads the ones validated above.
  .passthrough();

export const syncPositionsBody = z.object({
  positions: z.array(syncedPosition).max(50),
});

export const closedEventsQuery = z.object({
  since: z.coerce.number().finite().nonnegative().optional(),
});

// ---------- exchange / broker ----------

export const cancelOrderBody = z.object({
  id: z.string().min(1).max(128),
});

export const coinDcxCandlesQuery = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{1,15}$/, "base asset like BTC"),
  // What CoinDCX offers for INR markets, plus 5m, which the server builds from 1m.
  interval: z.enum(["1m", "5m", "15m", "1h", "1d"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const coinDcxOrderBookQuery = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{1,15}$/, "base asset like BTC"),
});

// ---------- server scanner ----------

const promotedModel = z
  .object({
    datasetName: z.string().max(300),
    winRatePct: z.number().finite(),
    isSynthetic: z.boolean().optional(),
    optimizedParameters: z
      .object({
        slMultiplier: positiveNumber,
        tpMultiplier: positiveNumber,
        volSurgeThreshold: positiveNumber,
        rsiThreshold: z.number().finite(),
        minConfidence: z.number().finite().min(0).max(1),
      })
      .optional(),
  })
  // Display fields (dates, lessons, metrics) ride along unchanged.
  .passthrough();

export const deskStateBody = z.object({
  equity: z.number().finite(),
  riskLimits: z.object({
    maxOrderValueInr: positiveNumber.max(10_000_000),
    maxAllowedExposureFraction: z.number().finite().positive().max(1),
  }),
  dailyRealizedPnl: z.number().finite(),
  autopilot: z.boolean(),
  tradingMode: z.enum(["PAPER", "LIVE_COINDCX"]).optional(),
  trailProfile: z.enum(["tight", "balanced", "patient", "fixed"]).optional(),
  killSwitch: z.boolean(),
  lossStreak: z.number().int().min(0).max(10_000).optional(),
  scanning: z.boolean(),
  failureState: z.object({
    simulateAgentTimeout: z.boolean(),
    simulateStaleMarketData: z.boolean(),
    simulateDailyLossBreach: z.boolean(),
    simulateOrderBookThinLiquidity: z.boolean(),
    simulateConflictingSignals: z.boolean(),
    globalKillSwitchActive: z.boolean(),
  }),
  quarantines: z.record(z.string().max(32), z.object({ quarantinedUntilMs: z.number().finite() })),
  promotedModel: promotedModel.nullable(),
});

// ---------- push notifications ----------

const pushEndpoint = z.string().url().max(2048).refine((u) => u.startsWith("https://"), "push endpoints are https");

export const pushSubscribeBody = z.object({
  subscription: z.object({
    endpoint: pushEndpoint,
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
  }),
});

export const pushUnsubscribeBody = z.object({ endpoint: pushEndpoint });

export const scannerReportsQuery = z.object({
  since: z.coerce.number().finite().nonnegative().optional(),
});

export const zerodhaCallbackBody = z.object({
  requestToken: z.string().min(1).max(256),
});

export const zerodhaCandlesQuery = z.object({
  symbol: z.string().regex(/^[A-Z0-9&-]{1,32}$/, "NSE trading symbol"),
  interval: z
    .enum(["minute", "3minute", "5minute", "10minute", "15minute", "30minute", "60minute", "day"])
    .optional(),
});

// ---------- AI agents (loose: context objects are passed to the model) ----------

const jsonObject = z.record(z.unknown());

export const marketAnalysisBody = z.object({
  symbol: symbol.optional(),
  timeframe: z.string().max(16).optional(),
  price: z.number().finite().nullish(),
  indicators: jsonObject.nullish(),
  simulateTimeout: z.boolean().optional(),
  recentSwingHigh: z.number().finite().nullish(),
  recentSwingLow: z.number().finite().nullish(),
});

export const supervisorBody = z.object({
  symbol: symbol.optional(),
  setup: jsonObject.optional(),
  marketAnalysis: jsonObject.optional(),
  similarExperiences: z.array(z.unknown()).max(50).optional(),
  rawExternalNews: z.string().max(5000).optional(),
  simulateTimeout: z.boolean().optional(),
});

export const tradeAutopsyBody = z.object({
  trade: jsonObject,
});
