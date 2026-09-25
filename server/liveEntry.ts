import { evaluateLiveOrder, recordLiveOrder, withLiveOrderLock } from "./liveOrderGuard";
import { clientOrderId, getLivePosition, lookupByClientOrderId, placeMarketOrder, registerLiveEntry } from "./liveExecution";
import { getCoinDcxCredentials, getReferencePrice } from "./routes/coindcx";
import { getMarketRule } from "./marketRules";
import { fitQuantity } from "../src/shared/marketRules";

// Opening a LIVE CoinDCX position: the one path every real entry takes,
// whether you approved it in the app (/api/execute-trade) or the server's
// autopilot did. The size is fitted to the market's rules, re-checked
// against the server's own caps (LIVE_* settings, LIVE_TRADING_ENABLED),
// sent with a deterministic client order id, and registered so the server
// owns its exit. A lost response is looked up before anything is resent.

export interface LiveEntryRequest {
  userId: string;
  positionId: string;
  /** "BTC/INR", "BTCINR" or "B-BTC_INR". */
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  /** The price the order was sized at, for the server's price-deviation check. */
  price?: number;
}

export type LiveEntryResult =
  | { ok: true; orderId: string; executedPrice?: number; quantity: number; duplicate?: boolean; data?: unknown }
  | { ok: false; status: number; error: string; code?: string; data?: unknown };

/** "BTC/INR" → "BTCINR". */
export const coinDcxMarket = (symbol: string) => symbol.replace(/^[A-Za-z]+-/, "").replace(/[\/_-]/g, "").toUpperCase();

export function placeLiveEntry(req: LiveEntryRequest): Promise<LiveEntryResult> {
  const { apiKey, apiSecret } = getCoinDcxCredentials();
  if (!apiKey || !apiSecret) {
    return Promise.resolve({
      ok: false,
      status: 401,
      error: "CoinDCX API credentials are not configured on the server (COINDCX_API_KEY / COINDCX_API_SECRET).",
      code: "MISSING_KEYS",
    });
  }
  const market = coinDcxMarket(req.symbol);
  const side = req.side;
  let quantity = Number(req.quantity);

  return withLiveOrderLock(async (): Promise<LiveEntryResult> => {
    const existing = getLivePosition(req.positionId);
    if (existing) {
      // Same position submitted twice: never open it again.
      return { ok: true, orderId: existing.entryOrderId ?? "", quantity: existing.quantity, duplicate: true };
    }

    // Fit the size to CoinDCX's rules for this market (quantity step and
    // minimums) so the exchange doesn't reject it, and so the guard below and
    // the position record use the quantity actually sent.
    const referencePrice = await getReferencePrice(market);
    const rule = await getMarketRule(market);
    if (rule && referencePrice) {
      const fit = fitQuantity(quantity, referencePrice, rule);
      if (!fit.ok) return { ok: false, status: 400, error: fit.reason, code: "BELOW_EXCHANGE_MINIMUM" };
      quantity = fit.quantity;
    }

    const decision = evaluateLiveOrder({
      market,
      side,
      quantity,
      clientPrice: req.price === undefined || req.price === null ? undefined : Number(req.price),
      referencePrice,
    });
    if (decision.status === "rejected" || decision.isReducing) {
      const error =
        decision.status === "rejected" ? decision.reason : "This order would net against an open live position; close that position instead.";
      const code = decision.status === "rejected" ? decision.code : "WOULD_REDUCE";
      console.warn(`[LiveOrderGuard] Rejected ${side} ${quantity} ${market} (user ${req.userId}): ${error}`);
      return { ok: false, status: 403, error, code };
    }

    const entryClientOrderId = clientOrderId("open", req.positionId);
    const accept = (orderId: string, data?: any): LiveEntryResult => {
      recordLiveOrder(market, side, quantity, decision.notionalInr, false);
      registerLiveEntry({ positionId: req.positionId, userId: req.userId, market, entrySide: side, quantity, entryOrderId: orderId, entryClientOrderId });
      console.log(`[LiveOrder] ${side} ${quantity} ${market} accepted (order ${orderId}, position ${req.positionId}, user ${req.userId})`);
      const filled = Number(data?.orders?.[0]?.price_per_unit);
      return { ok: true, orderId, executedPrice: filled > 0 ? filled : req.price, quantity, data };
    };

    try {
      const result = await placeMarketOrder(market, side, quantity, entryClientOrderId);
      if (!result.ok) {
        return { ok: false, status: result.status, error: result.data?.message || `CoinDCX rejected order (${result.status})`, data: result.data };
      }
      return accept(result.orderId || entryClientOrderId, result.data);
    } catch (e: any) {
      // The request may have reached CoinDCX even though we lost the response.
      // If it did, register the position so the guardian still protects it.
      const found = await lookupByClientOrderId(entryClientOrderId);
      if (found.state === "found") return accept(found.orderId || entryClientOrderId);
      console.error("[CoinDCX Order Dispatch] Error:", e);
      return {
        ok: false,
        status: 502,
        error:
          found.state === "unknown"
            ? `Order outcome unknown (${e.message}). Check CoinDCX for client order ${entryClientOrderId} before retrying.`
            : e.message || "Failed to dispatch order to CoinDCX",
        code: found.state === "unknown" ? "OUTCOME_UNKNOWN" : "DISPATCH_FAILED",
      };
    }
  });
}
