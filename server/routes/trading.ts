import { Router, type Request, type Response } from "express";
import type { AuthedRequest } from "../auth";
import { isLiveOrderRequest } from "../liveOrderGuard";
import { getLivePosition, listLivePositions, requestLiveExit, setLiveExitListener } from "../liveExecution";
import { placeLiveEntry } from "../liveEntry";
import { daemonPositions, scheduleDaemonDiskSave } from "../guardian";
import { broadcastToUser } from "../realtime";

import { validate, executeTradeBody, closePositionBody } from "../validation";

export const router = Router();

setLiveExitListener((rec) => broadcastToUser(rec.userId, { type: "LIVE_EXIT_UPDATE", data: rec }));

// CoinDCX Authenticated Trade Execution Route
router.post("/api/execute-trade", validate({ body: executeTradeBody }), async (req, res) => {
  const { symbol, side, quantity, price, positionId } = req.body;

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
  if (typeof symbol !== "string" || !["LONG", "SHORT", "buy", "sell"].includes(side)) {
    return res.status(400).json({ success: false, error: "symbol and side (LONG/SHORT/buy/sell) are required", code: "BAD_REQUEST" });
  }
  if (typeof positionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(positionId)) {
    return res.status(400).json({ success: false, error: "positionId is required for live orders", code: "BAD_REQUEST" });
  }
  const userId: string = (req as AuthedRequest).user!.uid;

  // This route only OPENS live positions; exits go through
  // /api/live/close-position so the server owns them.
  const result = await placeLiveEntry({
    userId,
    positionId,
    symbol,
    side: side === "LONG" || side === "buy" ? "buy" : "sell",
    quantity: Number(quantity),
    price: price === undefined || price === null ? undefined : Number(price),
  });
  if (!result.ok) {
    return res.status(result.status).json({ success: false, error: result.error, code: result.code, cdcxResponse: result.data });
  }
  if (result.duplicate) {
    // Same position submitted twice: never open it again.
    return res.json({ success: true, mode: "LIVE", orderId: result.orderId, duplicate: true, message: "Position already opened." });
  }
  return res.json({
    success: true,
    mode: "LIVE",
    message: "LIVE TRADE: Order dispatched & accepted by CoinDCX Exchange.",
    orderId: result.orderId,
    executedPrice: result.executedPrice ?? price,
    executedQuantity: result.quantity,
    cdcxResponse: result.data,
    timestamp: new Date().toISOString(),
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

