import { describe, expect, it, vi } from "vitest";
import {
  closePositionBody,
  coinDcxCandlesQuery,
  executeTradeBody,
  syncPositionsBody,
  tradeAutopsyBody,
  validate,
} from "../../server/validation";

const trade = { symbol: "BTC/INR", side: "LONG", quantity: 0.01, price: 1000, orderType: "MARKET", isPaperTrade: true, confirmLiveOrder: false, positionId: "pos-123456" };

describe("executeTradeBody", () => {
  it("accepts what the client sends", () => {
    expect(executeTradeBody.safeParse(trade).success).toBe(true);
  });

  it.each([
    ["missing price", { ...trade, price: undefined }],
    ["negative quantity", { ...trade, quantity: -1 }],
    ["string quantity", { ...trade, quantity: "1" }],
    ["unknown side", { ...trade, side: "UP" }],
    ["bad positionId", { ...trade, positionId: "../../etc" }],
    ["huge symbol", { ...trade, symbol: "X".repeat(100) }],
  ])("rejects %s", (_n, body) => {
    expect(executeTradeBody.safeParse(body).success).toBe(false);
  });

  it("passes live flags through untouched for isLiveOrderRequest to judge", () => {
    const r = executeTradeBody.parse({ ...trade, isPaperTrade: "false", confirmLiveOrder: "true" });
    expect(r.isPaperTrade).toBe("false");
    expect(r.confirmLiveOrder).toBe("true");
  });
});

describe("syncPositionsBody", () => {
  const pos = { id: "pos-1", symbol: "BTC/INR", direction: "LONG", entryPrice: 1000, quantity: 1, stopLoss: 990, takeProfit: 1100, openTime: "2026-01-01T00:00:00Z" };

  it("keeps display fields the guardian doesn't read", () => {
    const r = syncPositionsBody.parse({ positions: [{ ...pos, unrealizedPnl: 5, metaConfidence: 0.7 }] });
    expect(r.positions[0]).toMatchObject({ unrealizedPnl: 5, metaConfidence: 0.7 });
  });

  it("drops a bad non-critical field instead of failing the whole sync", () => {
    const r = syncPositionsBody.parse({ positions: [{ ...pos, trailMode: "DYNAMIC_RATIO", atrAtEntry: -3 }] });
    expect(r.positions[0].trailMode).toBeUndefined();
    expect(r.positions[0].atrAtEntry).toBeUndefined();
  });

  it.each([
    ["missing stopLoss", { ...pos, stopLoss: undefined }],
    ["zero entry price", { ...pos, entryPrice: 0 }],
    ["bad direction", { ...pos, direction: "SIDEWAYS" }],
  ])("rejects a position with %s", (_n, p) => {
    expect(syncPositionsBody.safeParse({ positions: [p] }).success).toBe(false);
  });

  it("caps the batch size", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ...pos, id: `pos-${i}` }));
    expect(syncPositionsBody.safeParse({ positions: many }).success).toBe(false);
  });
});

describe("other schemas", () => {
  it("coerces and bounds the candles query", () => {
    expect(coinDcxCandlesQuery.parse({ symbol: "BTC", interval: "1h", limit: "100" })).toEqual({ symbol: "BTC", interval: "1h", limit: 100 });
    expect(coinDcxCandlesQuery.safeParse({ symbol: "BTC&limit=5" }).success).toBe(false);
    expect(coinDcxCandlesQuery.safeParse({ symbol: "BTC", limit: "99999" }).success).toBe(false);
  });

  it("requires a positionId to close a live position", () => {
    expect(closePositionBody.safeParse({}).success).toBe(false);
    expect(closePositionBody.safeParse({ positionId: "pos-1", reason: "STOP_LOSS" }).success).toBe(true);
  });

  it("requires the trade object for autopsies", () => {
    expect(tradeAutopsyBody.safeParse({ symbol: "BTC/INR", pnl: 5 }).success).toBe(false);
    expect(tradeAutopsyBody.safeParse({ trade: { symbol: "BTC/INR" } }).success).toBe(true);
  });
});

describe("validate middleware", () => {
  const res = () => {
    const r: any = {};
    r.status = vi.fn(() => r);
    r.json = vi.fn(() => r);
    return r;
  };

  it("replaces req.body with parsed data and calls next", () => {
    const req: any = { body: { ...trade, extra: "dropped" } };
    const next = vi.fn();
    validate({ body: executeTradeBody })(req, res(), next);
    expect(next).toHaveBeenCalled();
    expect(req.body.extra).toBeUndefined();
  });

  it("responds 400 with the failing paths", () => {
    const r = res();
    const next = vi.fn();
    validate({ body: executeTradeBody })({ body: { ...trade, price: "free" } } as any, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json.mock.calls[0][0]).toMatchObject({ code: "VALIDATION_ERROR", issues: [{ path: "price" }] });
  });
});
