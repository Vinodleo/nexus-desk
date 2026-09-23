import { Router, type Request, type Response } from "express";
import type { AuthedRequest } from "../auth";
import { evaluateLiveOrder, isLiveOrderRequest, recordLiveOrder, withLiveOrderLock } from "../liveOrderGuard";
import {
  clientOrderId,
  getLivePosition,
  listLivePositions,
  lookupByClientOrderId,
  placeMarketOrder,
  registerLiveEntry,
  requestLiveExit,
  setLiveExitListener,
} from "../liveExecution";
import { daemonPositions, scheduleDaemonDiskSave } from "../guardian";
import { broadcastToUser } from "../realtime";
import { getCoinDcxCredentials, getReferencePrice } from "./coindcx";

import { validate, executeTradeBody, closePositionBody } from "../validation";

export const router = Router();

setLiveExitListener((rec) => broadcastToUser(rec.userId, { type: "LIVE_EXIT_UPDATE", data: rec }));

// CoinDCX Authenticated Trade Execution Route
router.post("/api/execute-trade", validate({ body: executeTradeBody }), async (req, res) => {
  const { symbol, side, quantity, price, positionId } = req.body;
  const { apiKey, apiSecret } = getCoinDcxCredentials(req);

  // Ambiguous input never resolves to "spend real money" (see isLiveOrderRequest).
  const wantsLiveOrder = isLiveOrderRequest(req.body);

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
      error: "CoinDCX API credentials are not configured on the server (COINDCX_API_KEY / COINDCX_API_SECRET).",
      code: "MISSING_KEYS"
    });
  }
  if (typeof symbol !== "string" || !["LONG", "SHORT", "buy", "sell"].includes(side)) {
    return res.status(400).json({ success: false, error: "symbol and side (LONG/SHORT/buy/sell) are required", code: "BAD_REQUEST" });
  }

  if (typeof positionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(positionId)) {
    return res.status(400).json({ success: false, error: "positionId is required for live orders", code: "BAD_REQUEST" });
  }
  const userId: string = (req as AuthedRequest).user!.uid;

  // Format market pair for CoinDCX: e.g. "BTC/INR" -> "BTCINR", "B-BTC_INR" -> "BTCINR"
  const cleanMarket = symbol.replace(/^[A-Za-z]+-/, "").replace(/[\/_-]/g, "").toUpperCase();
  // CoinDCX side is "buy" or "sell"
  const orderSide: "buy" | "sell" = (side === "LONG" || side === "buy") ? "buy" : "sell";
  const orderQty = Number(quantity);

  // This route only OPENS live positions; exits go through
  // /api/live/close-position so the server owns them.
  return withLiveOrderLock(async () => {
  const existing = getLivePosition(positionId);
  if (existing) {
    // Same position submitted twice: never open it again.
    return res.json({ success: true, mode: "LIVE", orderId: existing.entryOrderId, duplicate: true, message: "Position already opened." });
  }

  const decision = evaluateLiveOrder({
    market: cleanMarket,
    side: orderSide,
    quantity: orderQty,
    clientPrice: price === undefined || price === null ? undefined : Number(price),
    referencePrice: await getReferencePrice(cleanMarket),
  });
  if (decision.status === "rejected" || decision.isReducing) {
    const reason = decision.status === "rejected"
      ? decision.reason
      : "This order would net against an open live position; close that position instead.";
    const code = decision.status === "rejected" ? decision.code : "WOULD_REDUCE";
    console.warn(`[LiveOrderGuard] Rejected ${orderSide} ${orderQty} ${cleanMarket} (user ${(req as AuthedRequest).user?.email}): ${reason}`);
    return res.status(403).json({ success: false, error: reason, code });
  }

  const entryClientOrderId = clientOrderId("open", positionId);
  const accept = (orderId: string, data?: any) => {
    recordLiveOrder(cleanMarket, orderSide, orderQty, decision.notionalInr, false);
    registerLiveEntry({ positionId, userId, market: cleanMarket, entrySide: orderSide, quantity: orderQty, entryOrderId: orderId, entryClientOrderId });
    console.log(`[LiveOrder] ${orderSide} ${orderQty} ${cleanMarket} accepted (order ${orderId}, position ${positionId}, user ${(req as AuthedRequest).user?.email})`);
    return res.json({
      success: true,
      mode: "LIVE",
      message: "LIVE TRADE: Order dispatched & accepted by CoinDCX Exchange.",
      orderId,
      executedPrice: Number(data?.orders?.[0]?.price_per_unit || price),
      cdcxResponse: data,
      timestamp: new Date().toISOString(),
    });
  };

  try {
    const result = await placeMarketOrder(cleanMarket, orderSide, orderQty, entryClientOrderId);
    if (!result.ok) {
      return res.status(result.status).json({
        success: false,
        error: result.data?.message || `CoinDCX rejected order (${result.status})`,
        cdcxResponse: result.data,
      });
    }
    return accept(result.orderId || entryClientOrderId, result.data);
  } catch (e: any) {
    // The request may have reached CoinDCX even though we lost the response.
    // If it did, register the position so the guardian still protects it.
    const found = await lookupByClientOrderId(entryClientOrderId);
    if (found.state === "found") return accept(found.orderId || entryClientOrderId);
    console.error("[CoinDCX Order Dispatch] Error:", e);
    return res.status(502).json({
      success: false,
      error: found.state === "unknown"
        ? `Order outcome unknown (${e.message}). Check CoinDCX for client order ${entryClientOrderId} before retrying.`
        : e.message || "Failed to dispatch order to CoinDCX",
      code: found.state === "unknown" ? "OUTCOME_UNKNOWN" : "DISPATCH_FAILED",
    });
  }
  });
});

// Close a live position. The server sends the exit (idempotently, with
// retries); the client only asks. Safe to call more than once.
router.post("/api/live/close-position", validate({ body: closePositionBody }), async (req: Request, res: Response) => {
  const { positionId, reason } = req.body;
  const rec = getLivePosition(positionId);
  if (!rec || rec.userId !== (req as AuthedRequest).user!.uid) {
    return res.status(404).json({ success: false, error: "No live position with that id", code: "NOT_FOUND" });
  }
  // Stop the guardian from also acting on it; the exit below covers it.
  daemonPositions.delete(positionId);
  scheduleDaemonDiskSave(0);
  const updated = await requestLiveExit(positionId, reason ?? "MANUAL");
  const status = updated?.status;
  return res.status(status === "CLOSED" ? 200 : 202).json({
    success: status === "CLOSED",
    status,
    error: status === "CLOSED" ? undefined : updated?.lastError,
    position: updated,
  });
});

router.get("/api/live/positions", (req: Request, res: Response) => {
  res.json({ success: true, positions: listLivePositions((req as AuthedRequest).user!.uid) });
});

