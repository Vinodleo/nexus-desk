import { describe, expect, it, vi } from "vitest";
import {
  closePositionBody,
  coinDcxCandlesQuery,
  deskStateBody,
  executeTradeBody,
  appPosition,
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

describe("appPosition (the position sent with an order)", () => {
  const pos = { id: "pos-1", symbol: "BTC/INR", direction: "LONG", entryPrice: 1000, quantity: 1, stopLoss: 990, takeProfit: 1100, openTime: "2026-01-01T00:00:00Z" };

  it("keeps display fields the guardian doesn't read", () => {
    expect(appPosition.parse({ ...pos, unrealizedPnl: 5, metaConfidence: 0.7 })).toMatchObject({ unrealizedPnl: 5, metaConfidence: 0.7 });
  });

  it("drops a bad non-critical field instead of failing the whole order", () => {
    const r = appPosition.parse({ ...pos, trailMode: "DYNAMIC_RATIO", atrAtEntry: -3 });
    expect(r.trailMode).toBeUndefined();
    expect(r.atrAtEntry).toBeUndefined();
  });

  it("keeps the signal's price for the entry slippage, dropping a bad one", () => {
    expect(appPosition.parse({ ...pos, signalPrice: 998 }).signalPrice).toBe(998);
    expect(appPosition.parse({ ...pos, signalPrice: -1 }).signalPrice).toBeUndefined();
  });

  it("keeps a slower strategy's mark (breakout, momentum), dropping one it doesn't know", () => {
    for (const strategy of ["breakout", "momentum"]) expect(appPosition.parse({ ...pos, strategy }).strategy).toBe(strategy);
    expect(appPosition.parse({ ...pos, strategy: "martingale" }).strategy).toBeUndefined();
  });

  it.each([
    ["missing stopLoss", { ...pos, stopLoss: undefined }],
    ["zero entry price", { ...pos, entryPrice: 0 }],
    ["bad direction", { ...pos, direction: "SIDEWAYS" }],
  ])("rejects a position with %s", (_n, p) => {
    expect(appPosition.safeParse(p).success).toBe(false);
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

describe("deskStateBody", () => {
  const limit = { amountPerTradeInr: 5000, maxOpenTrades: 2 };
  const desk = (marketLimits: unknown) => ({
    equity: 100000, riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1, marketLimits },
    dailyRealizedPnl: 0, autopilot: true, killSwitch: false, scanning: true,
    failureState: {
      simulateAgentTimeout: false, simulateStaleMarketData: false, simulateDailyLossBreach: false,
      simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false, globalKillSwitchActive: false,
    },
    quarantines: {}, promotedModel: null,
  });

  it("keeps each market's risk per trade, and still takes limits from an app without it", () => {
    const parsed = deskStateBody.parse(desk({ coins: { ...limit, riskPerTradeInr: 150 }, stocks: limit, us: limit }));
    expect(parsed.riskLimits.marketLimits?.coins.riskPerTradeInr).toBe(150);
    expect(parsed.riskLimits.marketLimits?.stocks.riskPerTradeInr).toBeUndefined();
    expect(deskStateBody.safeParse(desk({ coins: { ...limit, riskPerTradeInr: -1 }, stocks: limit })).success).toBe(false);
  });

  it("keeps US momentum's own slots (none switches it off)", () => {
    const parsed = deskStateBody.parse(desk({ coins: limit, stocks: limit, us: { ...limit, momentumTrades: 0 } }));
    expect(parsed.riskLimits.marketLimits?.us?.momentumTrades).toBe(0);
    expect(parsed.riskLimits.marketLimits?.coins.momentumTrades).toBeUndefined();
    for (const odd of [21, 1.5, -1]) expect(deskStateBody.safeParse(desk({ coins: limit, stocks: limit, us: { ...limit, momentumTrades: odd } })).success).toBe(false);
  });

  it("keeps breakout's own slots (none switches it off), and still takes limits from an app without them", () => {
    const parsed = deskStateBody.parse(desk({ coins: { ...limit, breakoutTrades: 0 }, stocks: limit, us: { ...limit, breakoutTrades: 5 } }));
    expect(parsed.riskLimits.marketLimits?.coins.breakoutTrades).toBe(0);
    expect(parsed.riskLimits.marketLimits?.us?.breakoutTrades).toBe(5);
    expect(parsed.riskLimits.marketLimits?.stocks.breakoutTrades).toBeUndefined();
    for (const odd of [21, 1.5, -1]) expect(deskStateBody.safeParse(desk({ coins: { ...limit, breakoutTrades: odd }, stocks: limit })).success).toBe(false);
  });
});
