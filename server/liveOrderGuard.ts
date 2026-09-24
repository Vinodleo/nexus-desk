import fs from "fs";
import path from "path";

// Server-side risk limits for LIVE CoinDCX orders. The browser's risk engine
// is advisory only — a crafted request can skip it — so every live order is
// re-checked here before it is signed. All limits come from env vars and
// default to conservative values; live trading is off unless
// LIVE_TRADING_ENABLED=true.
//
// Orders that reduce a position this server itself opened (tracked in
// `netQty`) are always allowed through the caps, so an exit is never blocked
// by the daily limits or the kill switch.

// Fail-safe default: a request only goes live if isPaperTrade is exactly
// `false` AND confirmLiveOrder is exactly `true`. Anything else — missing,
// undefined, malformed, truthy strings — stays paper.
export function isLiveOrderRequest(body: unknown): boolean {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return b.isPaperTrade === false && b.confirmLiveOrder === true;
}

export interface LiveRiskConfig {
  enabled: boolean;
  allowedMarkets: Set<string>;
  maxOrderNotionalInr: number;
  maxDailyNotionalInr: number;
  maxDailyOrders: number;
  maxPriceDeviationPct: number;
}

const DEFAULT_MARKETS = "BTCINR,ETHINR,SOLINR,AVAXINR,NEARINR,JUPINR,XRPINR";

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function loadLiveRiskConfig(): LiveRiskConfig {
  return {
    enabled: process.env.LIVE_TRADING_ENABLED === "true",
    allowedMarkets: new Set(
      (process.env.LIVE_ALLOWED_MARKETS || DEFAULT_MARKETS)
        .split(",")
        .map((m) => m.trim().toUpperCase())
        .filter(Boolean)
    ),
    maxOrderNotionalInr: numEnv("LIVE_MAX_ORDER_NOTIONAL_INR", 5000),
    maxDailyNotionalInr: numEnv("LIVE_MAX_DAILY_NOTIONAL_INR", 20000),
    maxDailyOrders: numEnv("LIVE_MAX_DAILY_ORDERS", 10),
    maxPriceDeviationPct: numEnv("LIVE_MAX_PRICE_DEVIATION_PCT", 1.0),
  };
}

interface LedgerState {
  day: string; // trading day in Asia/Kolkata
  openedNotionalInr: number;
  openedOrders: number;
  netQty: Record<string, number>; // signed base-asset quantity per market (+ long / - short)
}

const LEDGER_DIR = process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const LEDGER_FILE = path.join(LEDGER_DIR, "live_order_ledger.json");
const EPSILON = 1e-9;

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function loadLedger(): LedgerState {
  try {
    if (fs.existsSync(LEDGER_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
      return {
        day: String(parsed.day || today()),
        openedNotionalInr: Number(parsed.openedNotionalInr) || 0,
        openedOrders: Number(parsed.openedOrders) || 0,
        netQty: parsed.netQty && typeof parsed.netQty === "object" ? parsed.netQty : {},
      };
    }
  } catch (err) {
    console.error("[LiveOrderGuard] Failed to read ledger, starting empty:", err);
  }
  return { day: today(), openedNotionalInr: 0, openedOrders: 0, netQty: {} };
}

let ledger = loadLedger();

function saveLedger() {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    fs.writeFileSync(LEDGER_FILE + ".tmp", JSON.stringify(ledger, null, 2), "utf8");
    fs.renameSync(LEDGER_FILE + ".tmp", LEDGER_FILE);
  } catch (err) {
    console.error("[LiveOrderGuard] Failed to save ledger:", err);
  }
}

function rollDay() {
  const d = today();
  if (ledger.day !== d) {
    // Daily caps reset; open quantities carry over.
    ledger = { day: d, openedNotionalInr: 0, openedOrders: 0, netQty: ledger.netQty };
    saveLedger();
  }
}

export interface LiveOrderRequest {
  market: string; // e.g. "BTCINR"
  side: "buy" | "sell";
  quantity: number;
  clientPrice: number | undefined;
  referencePrice: number | undefined; // server-observed last price
}

export type LiveOrderDecision =
  | { status: "accepted"; notionalInr: number; isReducing: boolean }
  | { status: "rejected"; code: string; reason: string };

export function evaluateLiveOrder(req: LiveOrderRequest, cfg: LiveRiskConfig = loadLiveRiskConfig()): LiveOrderDecision {
  rollDay();

  if (!cfg.allowedMarkets.has(req.market)) {
    return { status: "rejected", code: "MARKET_NOT_ALLOWED", reason: `Market ${req.market} is not on LIVE_ALLOWED_MARKETS.` };
  }
  if (!Number.isFinite(req.quantity) || req.quantity <= 0) {
    return { status: "rejected", code: "BAD_QUANTITY", reason: "Quantity must be a positive number." };
  }
  // Exits are checked first: they're sent as market orders, so a stale
  // client price or a missing reference price must never block them.
  const held = ledger.netQty[req.market] || 0;
  const signedQty = req.side === "buy" ? req.quantity : -req.quantity;
  const isReducing = held !== 0 && Math.sign(signedQty) !== Math.sign(held) && req.quantity <= Math.abs(held) + EPSILON;
  if (isReducing) {
    return { status: "accepted", notionalInr: req.quantity * (req.referencePrice || req.clientPrice || 0), isReducing };
  }
  // CoinDCX's INR markets are spot: selling more than is held would be a
  // short, which the exchange can't fill. Only buys open positions.
  if (req.side === "sell") {
    return {
      status: "rejected",
      code: "NO_SPOT_SHORT",
      reason: `Can't sell ${req.quantity} ${req.market}: only ${Math.max(0, held)} is held, and CoinDCX spot markets can't be shorted.`,
    };
  }

  if (!req.referencePrice || !Number.isFinite(req.referencePrice) || req.referencePrice <= 0) {
    return { status: "rejected", code: "NO_REFERENCE_PRICE", reason: `No server-side reference price for ${req.market}; refusing to size a live order blind.` };
  }
  if (req.clientPrice !== undefined && req.clientPrice !== null) {
    const clientPrice = Number(req.clientPrice);
    const deviationPct = (Math.abs(clientPrice - req.referencePrice) / req.referencePrice) * 100;
    if (!Number.isFinite(clientPrice) || deviationPct > cfg.maxPriceDeviationPct) {
      return {
        status: "rejected",
        code: "PRICE_DEVIATION",
        reason: `Order price ${req.clientPrice} deviates ${deviationPct.toFixed(2)}% from server price ${req.referencePrice} (limit ${cfg.maxPriceDeviationPct}%).`,
      };
    }
  }

  const notionalInr = req.quantity * req.referencePrice;

  if (!cfg.enabled) {
    return { status: "rejected", code: "LIVE_DISABLED", reason: "Live trading is disabled on the server (set LIVE_TRADING_ENABLED=true)." };
  }
  if (notionalInr > cfg.maxOrderNotionalInr) {
    return {
      status: "rejected",
      code: "ORDER_NOTIONAL_CAP",
      reason: `Order notional ₹${notionalInr.toFixed(2)} exceeds per-order cap ₹${cfg.maxOrderNotionalInr}.`,
    };
  }
  if (ledger.openedNotionalInr + notionalInr > cfg.maxDailyNotionalInr) {
    return {
      status: "rejected",
      code: "DAILY_NOTIONAL_CAP",
      reason: `Daily live notional would reach ₹${(ledger.openedNotionalInr + notionalInr).toFixed(2)} (cap ₹${cfg.maxDailyNotionalInr}).`,
    };
  }
  if (ledger.openedOrders + 1 > cfg.maxDailyOrders) {
    return { status: "rejected", code: "DAILY_ORDER_CAP", reason: `Daily live order cap of ${cfg.maxDailyOrders} reached.` };
  }
  return { status: "accepted", notionalInr, isReducing };
}

// Call only after the exchange has accepted the order.
export function recordLiveOrder(market: string, side: "buy" | "sell", quantity: number, notionalInr: number, isReducing: boolean) {
  rollDay();
  const next = (ledger.netQty[market] || 0) + (side === "buy" ? quantity : -quantity);
  if (Math.abs(next) < EPSILON) delete ledger.netQty[market];
  else ledger.netQty[market] = next;
  if (!isReducing) {
    ledger.openedNotionalInr += notionalInr;
    ledger.openedOrders += 1;
  }
  saveLedger();
}

export function liveRiskSnapshot() {
  rollDay();
  const cfg = loadLiveRiskConfig();
  return {
    enabled: cfg.enabled,
    allowedMarkets: Array.from(cfg.allowedMarkets),
    maxOrderNotionalInr: cfg.maxOrderNotionalInr,
    maxDailyNotionalInr: cfg.maxDailyNotionalInr,
    maxDailyOrders: cfg.maxDailyOrders,
    maxPriceDeviationPct: cfg.maxPriceDeviationPct,
    day: ledger.day,
    openedNotionalInrToday: Number(ledger.openedNotionalInr.toFixed(2)),
    openedOrdersToday: ledger.openedOrders,
    trackedNetQty: { ...ledger.netQty },
  };
}

// Serialize live orders so two concurrent requests can't both pass the caps
// before either is recorded.
let chain: Promise<unknown> = Promise.resolve();
export function withLiveOrderLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
