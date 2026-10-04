import crypto from "crypto";
import fs from "fs";
import path from "path";
import { recordLiveOrder, withLiveOrderLock } from "./liveOrderGuard";
import { getMarketRule } from "./marketRules";

// Server-owned lifecycle for LIVE CoinDCX positions.
//
// Every live entry is registered here (by the client's position id) when the
// exchange accepts it. Exits are always sent by the server — whether the
// position guardian hits a stop/target/expiry or the user closes it — so a
// closed or sleeping browser can never leave a real position open.
//
// Exits are idempotent: each send has its own deterministic client_order_id
// (CoinDCX refuses a reused one, even a rejected order's). Before sending
// again we ask CoinDCX whether the last one exists, and only send (under the
// next id) if it doesn't, or was rejected or cancelled. CoinDCX's docs
// (Oct 2026) confirm /exchange/v1/orders/status and /cancel take
// `client_order_id`.
//
// Each live long also has a backup stop resting at CoinDCX (a stop-limit
// sell, BACKSTOP_GAP below the server's stop): if the server is down when
// the price falls, CoinDCX sells anyway. The server's own stop stays the one
// that normally acts; the backup follows it up as it trails, and is
// cancelled before any exit (it holds the coins). If CoinDCX refuses stop
// orders, the owner is told and the server watches the stop alone, as before.
// CoinDCX's INR markets take only market and limit orders (its docs: "BTCINR
// market has only limit and market type orders"), so where its market list
// doesn't offer stop_limit no backup stop is tried: the server's stop, its
// automatic restarts and the uptime alert are the protection there.

type Side = "buy" | "sell";

export type LivePositionStatus = "OPEN" | "EXIT_PENDING" | "CLOSED" | "EXIT_FAILED";

/**
 * The backup stop at CoinDCX: PLACING until CoinDCX confirms it (looked up if
 * the answer is lost), OPEN while it rests there, CANCELLING until a cancel
 * is confirmed, CANCELLED (replaced, or cleared for an exit), FILLED when it
 * sold the position, REFUSED when CoinDCX wouldn't take it.
 */
export type ExchangeStopStatus = "PLACING" | "OPEN" | "CANCELLING" | "CANCELLED" | "FILLED" | "REFUSED" | "UNSUPPORTED";

export interface ExchangeStop {
  clientOrderId: string;
  orderId?: string;
  /** The price that triggers it, and the lowest it sells at once triggered. */
  stopPrice: number;
  limitPrice: number;
  status: ExchangeStopStatus;
  /** Which of this position's stop orders it is (each move places a new one). */
  seq: number;
  placedAt: string;
  /** When CoinDCX was last asked how it stands (ms). */
  checkedAt?: number;
  lastError?: string;
}

export interface LivePositionRecord {
  positionId: string;
  userId: string;
  market: string; // e.g. "BTCINR"
  entrySide: Side;
  quantity: number;
  entryOrderId: string;
  entryClientOrderId: string;
  openedAt: string;
  status: LivePositionStatus;
  exitReason?: string;
  exitClientOrderId?: string;
  exitOrderId?: string;
  exitSentAt?: string; // persisted before each send, so a crash mid-send triggers a lookup, not a blind resend
  exitAttempts: number;
  nextRetryAt?: number;
  lastError?: string;
  closedAt?: string;
  /** The backup stop resting at CoinDCX, once placed. */
  exchangeStop?: ExchangeStop;
  /** Exit orders sent so far (each under its own client order id). */
  exitSends?: number;
}

const MAX_EXIT_ATTEMPTS = 10;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000;

const DIR = process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DIR, "live_positions.json");

function load(): Record<string, LivePositionRecord> {
  try {
    if (fs.existsSync(FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (err) {
    console.error("[LiveExecution] Failed to read live position registry:", err);
  }
  return {};
}

const registry: Record<string, LivePositionRecord> = load();

function save() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(registry, null, 2), "utf8");
    fs.renameSync(FILE + ".tmp", FILE);
  } catch (err) {
    console.error("[LiveExecution] Failed to save live position registry:", err);
  }
}

// ---------- CoinDCX signed REST ----------

function credentials() {
  return {
    apiKey: (process.env.COINDCX_API_KEY || "").trim(),
    apiSecret: (process.env.COINDCX_API_SECRET || "").trim(),
  };
}

/** Whether the server has CoinDCX keys (names only; the keys never leave it). */
export function hasCoinDcxKeys(): boolean {
  const { apiKey, apiSecret } = credentials();
  return Boolean(apiKey && apiSecret);
}

async function signedPost(endpoint: string, body: Record<string, unknown>, timeoutMs?: number) {
  const { apiKey, apiSecret } = credentials();
  if (!apiKey || !apiSecret) throw new Error("CoinDCX API credentials are not configured on the server");
  const payload = JSON.stringify({ ...body, timestamp: Date.now() });
  const signature = crypto.createHmac("sha256", apiSecret).update(payload).digest("hex");
  const response = await fetch(`https://api.coindcx.com${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AUTH-APIKEY": apiKey, "X-AUTH-SIGNATURE": signature },
    body: payload,
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  const data: any = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

/**
 * Every currency held at CoinDCX, by name ("BTC", "INR"): the usable balance
 * plus what open orders hold (CoinDCX's docs: total = balance +
 * locked_balance). Throws when CoinDCX doesn't answer with the list.
 */
export async function fetchCoinBalances(): Promise<Record<string, number>> {
  const result = await signedPost("/exchange/v1/users/balances", {}, 30_000);
  if (!result.ok || !Array.isArray(result.data)) throw new Error(result.data?.message || `CoinDCX answered ${result.status}`);
  const held: Record<string, number> = {};
  for (const row of result.data) {
    const currency = String(row?.currency ?? row?.currency_short_name ?? "").toUpperCase();
    const total = (Number(row?.balance) || 0) + (Number(row?.locked_balance) || 0);
    if (currency) held[currency] = (held[currency] ?? 0) + total;
  }
  return held;
}

// CoinDCX client_order_id: keep it short and alphanumeric/underscore.
export function clientOrderId(kind: "open" | "exit", positionId: string): string {
  return `nx_${kind}_${positionId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 36);
}

/** A position's `attempt`th exit order (the first keeps the plain id). */
export function exitClientOrderId(positionId: string, attempt: number): string {
  return attempt <= 1 ? clientOrderId("exit", positionId) : `nx_exit${attempt}_${positionId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 36);
}

/** A position's `seq`th backup stop order. */
export function stopClientOrderId(positionId: string, seq: number): string {
  return `nx_s${seq}_${positionId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 36);
}

export async function placeMarketOrder(market: string, side: Side, quantity: number, clientOrderIdValue: string) {
  const result = await signedPost("/exchange/v1/orders/create", {
    side,
    order_type: "market_order",
    market,
    total_quantity: quantity,
    client_order_id: clientOrderIdValue,
  });
  const orderId = result.data?.orders?.[0]?.id || result.data?.id;
  return { ...result, orderId: orderId ? String(orderId) : undefined };
}

/** A stop-limit order: rests at CoinDCX until the price reaches `stopPrice`, then sells at `limitPrice` or better. */
export async function placeStopLimitOrder(market: string, side: Side, quantity: number, stopPrice: number, limitPrice: number, clientOrderIdValue: string) {
  const result = await signedPost("/exchange/v1/orders/create", {
    side,
    order_type: "stop_limit",
    market,
    total_quantity: quantity,
    stop_price: stopPrice,
    price_per_unit: limitPrice,
    client_order_id: clientOrderIdValue,
  });
  const orderId = result.data?.orders?.[0]?.id || result.data?.id;
  return { ...result, orderId: orderId ? String(orderId) : undefined };
}

/** An order, by CoinDCX's id when known, else by our client order id. */
type OrderRef = { orderId?: string; clientOrderId: string };
const refBody = (ref: OrderRef) => (ref.orderId ? { id: ref.orderId } : { client_order_id: ref.clientOrderId });

export async function cancelOrder(ref: OrderRef) {
  return signedPost("/exchange/v1/orders/cancel", refBody(ref));
}

/** CoinDCX's states for an order that no longer rests there. */
const DONE = new Set(["filled", "cancelled", "partially_cancelled", "rejected"]);

/**
 * How an order stands at CoinDCX: "found" with its status, how much of it
 * filled and at what average price; "not_found" when CoinDCX answered and
 * has none; "unknown" when it couldn't be asked (network, 5xx).
 */
export async function orderStatus(ref: OrderRef): Promise<{ state: "found" | "not_found" | "unknown"; status?: string; orderId?: string; filled?: number; avgPrice?: number }> {
  try {
    const result = await signedPost("/exchange/v1/orders/status", refBody(ref));
    if (result.ok && result.data?.id) {
      const total = Number(result.data.total_quantity);
      const remaining = Number(result.data.remaining_quantity);
      const filled = Number.isFinite(total) && Number.isFinite(remaining) ? Math.max(0, total - remaining) : undefined;
      const avg = Number(result.data.avg_price) || Number(result.data.price_per_unit);
      return { state: "found", status: String(result.data.status || "").toLowerCase(), orderId: String(result.data.id), filled, avgPrice: avg > 0 ? avg : undefined };
    }
    if (result.status >= 400 && result.status < 500) return { state: "not_found" };
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

// "found" = CoinDCX has an order with this client_order_id; "not_found" =
// it answered and has none; "unknown" = we couldn't tell (network/5xx).
export async function lookupByClientOrderId(clientOrderIdValue: string): Promise<{ state: "found" | "not_found" | "unknown"; orderId?: string }> {
  try {
    const result = await signedPost("/exchange/v1/orders/status", { client_order_id: clientOrderIdValue });
    if (result.ok && result.data?.id) {
      const status = String(result.data.status || "").toLowerCase();
      // A rejected/cancelled order never filled, so it's safe to send again.
      if (status === "rejected" || status === "cancelled") return { state: "not_found" };
      return { state: "found", orderId: String(result.data.id) };
    }
    if (result.status >= 400 && result.status < 500) return { state: "not_found" };
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

// ---------- Registry API ----------

export function registerLiveEntry(entry: {
  positionId: string;
  userId: string;
  market: string;
  entrySide: Side;
  quantity: number;
  entryOrderId: string;
  entryClientOrderId: string;
}) {
  registry[entry.positionId] = {
    ...entry,
    openedAt: new Date().toISOString(),
    status: "OPEN",
    exitAttempts: 0,
  };
  save();
}

export function getLivePosition(positionId: string): LivePositionRecord | undefined {
  return registry[positionId];
}

export function isOpenLivePosition(positionId: string): boolean {
  const rec = registry[positionId];
  return !!rec && rec.status !== "CLOSED";
}

export function listLivePositions(userId: string): LivePositionRecord[] {
  return Object.values(registry).filter((r) => r.userId === userId);
}

/** Every live position this server has recorded, whoever opened it (the daily check against CoinDCX). */
export function allLivePositions(): LivePositionRecord[] {
  return Object.values(registry);
}

type ExitListener = (rec: LivePositionRecord) => void;
let onExitUpdate: ExitListener = () => {};
export function setLiveExitListener(fn: ExitListener) {
  onExitUpdate = fn;
}

function scheduleRetry(rec: LivePositionRecord, error: string) {
  rec.lastError = error;
  if (rec.exitAttempts >= MAX_EXIT_ATTEMPTS) {
    rec.status = "EXIT_FAILED";
    rec.nextRetryAt = undefined;
    console.error(
      `[LiveExecution] EXIT FAILED after ${rec.exitAttempts} attempts for ${rec.positionId} (${rec.market}). ` +
        `The position may still be open on CoinDCX — close it manually. Last error: ${error}`
    );
  } else {
    rec.status = "EXIT_PENDING";
    rec.nextRetryAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (rec.exitAttempts - 1));
    console.warn(`[LiveExecution] Exit for ${rec.positionId} failed (attempt ${rec.exitAttempts}); retrying. ${error}`);
  }
  save();
  onExitUpdate(rec);
}

function markClosed(rec: LivePositionRecord, exitOrderId: string | undefined) {
  const exitSide: Side = rec.entrySide === "buy" ? "sell" : "buy";
  rec.status = "CLOSED";
  rec.exitOrderId = exitOrderId;
  rec.closedAt = new Date().toISOString();
  rec.nextRetryAt = undefined;
  rec.lastError = undefined;
  recordLiveOrder(rec.market, exitSide, rec.quantity, 0, true);
  save();
  console.log(`[LiveExecution] Exit ${exitSide} ${rec.quantity} ${rec.market} for ${rec.positionId} accepted (order ${exitOrderId}).`);
  onExitUpdate(rec);
}

async function attemptExit(rec: LivePositionRecord): Promise<void> {
  const exitSide: Side = rec.entrySide === "buy" ? "sell" : "buy";

  // The backup stop holds the coins: cancel it first, and see whether it sold any.
  const stop = rec.exchangeStop;
  if (!rec.exitSentAt && stop && (stop.status === "OPEN" || stop.status === "PLACING" || stop.status === "CANCELLING")) {
    stop.status = "CANCELLING";
    save();
    await cancelOrder(stop).catch(() => undefined);
    const st = await orderStatus(stop);
    if (st.state === "unknown" || (st.state === "found" && !DONE.has(st.status!))) {
      rec.exitAttempts += 1;
      return scheduleRetry(rec, "Couldn't confirm the backup stop at CoinDCX was cancelled; trying again");
    }
    if (st.state === "found" && st.status === "filled") {
      stop.status = "FILLED";
      return markClosed(rec, st.orderId);
    }
    // Part sold before the cancel: only the rest is left to sell.
    if ((st.filled ?? 0) > 0) rec.quantity = Number((rec.quantity - st.filled!).toFixed(8));
    stop.status = "CANCELLED";
    save();
  }

  // If an earlier send may have reached the exchange (even one interrupted by
  // a crash), check before sending again.
  if (rec.exitSentAt && rec.exitClientOrderId) {
    const existing = await lookupByClientOrderId(rec.exitClientOrderId);
    if (existing.state === "found") return markClosed(rec, existing.orderId);
    if (existing.state === "unknown") {
      rec.exitAttempts += 1;
      return scheduleRetry(rec, "Could not confirm whether the previous exit order reached CoinDCX");
    }
  }

  // No risk-cap check here: the registry entry proves this server opened the
  // position, and an exit must never be blocked by caps or the kill switch.
  rec.exitAttempts += 1;
  // A new id for each send: CoinDCX refuses one already used.
  rec.exitClientOrderId = exitClientOrderId(rec.positionId, (rec.exitSends ?? 0) + 1);
  rec.exitSends = (rec.exitSends ?? 0) + 1;
  rec.exitSentAt = new Date().toISOString();
  save();

  try {
    const result = await placeMarketOrder(rec.market, exitSide, rec.quantity, rec.exitClientOrderId);
    if (result.ok) return markClosed(rec, result.orderId);
    return scheduleRetry(rec, result.data?.message || `CoinDCX rejected exit (${result.status})`);
  } catch (err: any) {
    return scheduleRetry(rec, err?.message || "Network error sending exit order");
  }
}

// Idempotent: safe to call from the guardian and the user close path at the
// same time, or repeatedly. Only the first call for an OPEN position sends.
export function requestLiveExit(positionId: string, reason: string): Promise<LivePositionRecord | undefined> {
  return withLiveOrderLock(async () => {
    const rec = registry[positionId];
    if (!rec) return undefined;
    if (rec.status !== "OPEN") return rec;
    rec.exitReason = reason;
    rec.status = "EXIT_PENDING";
    save();
    await attemptExit(rec);
    return rec;
  });
}

// ---------- the backup stop at CoinDCX ----------

/** The backup stop sits this far below the server's stop: the server's normally acts first; CoinDCX's only if it doesn't. */
export const BACKSTOP_GAP = 0.005;
/** Once triggered it sells down to this far below its trigger, so a fast fall still fills. */
export const STOP_LIMIT_SLACK = 0.01;
/** It's moved up only once the server's stop has risen this much (each move is a cancel and a new order). */
export const STOP_MOVE_MIN = 0.005;
/** How often the backup stops are checked and moved. */
export const STOP_RECONCILE_MS = 15_000;
/** How often CoinDCX is asked whether a resting backup stop has sold. */
export const STOP_STATUS_EVERY_MS = 60_000;
/** After CoinDCX refuses one, it's tried again this much later. */
export const STOP_REFUSED_RETRY_MS = 6 * 60 * 60 * 1000;

/** The server's stop for a live position (the guardian's), or undefined while it doesn't know the position. */
let stopSource: (positionId: string) => number | undefined = () => undefined;
export function setStopSource(fn: (positionId: string) => number | undefined) {
  stopSource = fn;
}

export interface ExchangeStopListener {
  /** The backup stop sold the position at CoinDCX: close it in the guardian at that price (no exit is sent). */
  closed: (rec: LivePositionRecord, price: number) => void;
  /** CoinDCX refused the backup stop: tell the owner the server watches the stop alone. */
  refused: (rec: LivePositionRecord) => void;
}
let stopListener: ExchangeStopListener = { closed: () => {}, refused: () => {} };
export function setExchangeStopListener(listener: ExchangeStopListener) {
  stopListener = listener;
}

const roundDown = (x: number, digits: number) => Math.floor(x * 10 ** digits + 1e-9) / 10 ** digits;

/** The backup stop's trigger and limit for a server stop, to the market's price precision (else 5 significant figures). */
export async function backstopPrices(market: string, serverStop: number): Promise<{ stopPrice: number; limitPrice: number } | null> {
  if (!(serverStop > 0)) return null;
  const rule = await getMarketRule(market).catch(() => undefined);
  const digits = rule?.pricePrecision ?? Math.max(2, 4 - Math.floor(Math.log10(serverStop)));
  const stopPrice = roundDown(serverStop * (1 - BACKSTOP_GAP), digits);
  const limitPrice = roundDown(stopPrice * (1 - STOP_LIMIT_SLACK), digits);
  return stopPrice > 0 && limitPrice > 0 ? { stopPrice, limitPrice } : null;
}

/** The backup stop sold the position at CoinDCX: closed, and the guardian told. */
function closedByStop(rec: LivePositionRecord, st: { orderId?: string; avgPrice?: number }) {
  const stop = rec.exchangeStop!;
  stop.status = "FILLED";
  rec.exitReason = "STOP_LOSS";
  markClosed(rec, st.orderId ?? stop.orderId);
  console.warn(`[LiveExecution] The backup stop at CoinDCX sold ${rec.market} for ${rec.positionId}.`);
  stopListener.closed(rec, st.avgPrice ?? stop.limitPrice);
}

/** Learns how the backup stop stands at CoinDCX; true if it sold (the position is closed). */
async function refreshStop(rec: LivePositionRecord, now: number): Promise<boolean> {
  const stop = rec.exchangeStop!;
  const st = await orderStatus(stop);
  stop.checkedAt = now;
  if (st.state === "unknown") return false;
  if (st.state === "not_found") {
    // Never reached CoinDCX, or gone (cancelled there): placed again below.
    stop.status = "CANCELLED";
    return false;
  }
  stop.orderId ??= st.orderId;
  if (st.status === "filled") {
    closedByStop(rec, st);
    return true;
  }
  if (DONE.has(st.status!)) {
    stop.status = "CANCELLED";
    // It sold part before it was cancelled: the stop was reached, so the rest is sold too.
    if ((st.filled ?? 0) > 0) {
      rec.quantity = Number((rec.quantity - st.filled!).toFixed(8));
      rec.exitReason = "STOP_LOSS";
      rec.status = "EXIT_PENDING";
      save();
      await attemptExit(rec);
      stopListener.closed(rec, st.avgPrice ?? stop.limitPrice);
      return true;
    }
    return false;
  }
  // Still resting there (or selling): a cancel asked for earlier is asked again.
  if (stop.status === "CANCELLING") await cancelOrder(stop).catch(() => undefined);
  else stop.status = "OPEN";
  return false;
}

/** Places, checks or moves one live position's backup stop. */
async function reconcileStop(rec: LivePositionRecord, now: number): Promise<void> {
  if (rec.status !== "OPEN" || rec.entrySide !== "buy") return;
  const stop = rec.exchangeStop;
  if (stop && (stop.status === "PLACING" || stop.status === "CANCELLING" || (stop.status === "OPEN" && now - (stop.checkedAt ?? 0) >= STOP_STATUS_EVERY_MS))) {
    const sold = await refreshStop(rec, now);
    save();
    if (sold || stop.status === "PLACING" || stop.status === "CANCELLING") return;
  }
  const prices = await backstopPrices(rec.market, stopSource(rec.positionId) ?? NaN);
  if (!prices) return;
  // Not offered on this market (CoinDCX's INR markets): nothing to place, nothing to tell.
  const types = (await getMarketRule(rec.market).catch(() => undefined))?.orderTypes;
  if (types && !types.includes("stop_limit")) {
    if (stop?.status !== "UNSUPPORTED") {
      rec.exchangeStop = { clientOrderId: "", ...prices, status: "UNSUPPORTED", seq: stop?.seq ?? 0, placedAt: new Date(now).toISOString(), lastError: `CoinDCX takes no stop orders on ${rec.market}` };
      save();
      console.log(`[LiveExecution] No backup stop for ${rec.positionId}: CoinDCX takes no stop orders on ${rec.market}; the server watches its stop.`);
    }
    return;
  }
  if (stop?.status === "REFUSED" && now - Date.parse(stop.placedAt) < STOP_REFUSED_RETRY_MS) return;
  if (stop?.status === "OPEN") {
    if (prices.stopPrice < stop.stopPrice * (1 + STOP_MOVE_MIN)) return;
    // Moved up: the old one is cancelled (confirmed) before the new one goes in.
    stop.status = "CANCELLING";
    save();
    await cancelOrder(stop).catch(() => undefined);
    if ((await refreshStop(rec, now)) || (stop.status as ExchangeStopStatus) !== "CANCELLED") {
      save();
      return;
    }
  }
  const seq = (stop?.seq ?? 0) + 1;
  const next: ExchangeStop = { clientOrderId: stopClientOrderId(rec.positionId, seq), ...prices, status: "PLACING", seq, placedAt: new Date(now).toISOString() };
  rec.exchangeStop = next;
  save();
  try {
    const result = await placeStopLimitOrder(rec.market, "sell", rec.quantity, next.stopPrice, next.limitPrice, next.clientOrderId);
    if (result.ok) {
      next.status = "OPEN";
      next.orderId = result.orderId;
      next.checkedAt = now;
      console.log(`[LiveExecution] Backup stop for ${rec.positionId} at CoinDCX: sell ${rec.quantity} ${rec.market} below ${next.stopPrice}.`);
    } else if (result.status >= 400 && result.status < 500) {
      next.status = "REFUSED";
      next.lastError = result.data?.message || `CoinDCX refused the stop order (${result.status})`;
      console.warn(`[LiveExecution] CoinDCX refused the backup stop for ${rec.positionId}: ${next.lastError}. The server watches its stop alone.`);
      // Told once a trade, not at every retry.
      if (stop?.status !== "REFUSED") stopListener.refused(rec);
    } else {
      // Unclear whether it reached CoinDCX: looked up on the next check.
      next.lastError = result.data?.message || `CoinDCX answered ${result.status}`;
    }
  } catch (err: any) {
    next.lastError = err?.message || "Network error placing the backup stop";
  }
  save();
  onExitUpdate(rec);
}

/** Every open live long's backup stop: placed once the guardian knows its stop, checked, moved up as it trails. */
export async function reconcileExchangeStops(now: number = Date.now()): Promise<void> {
  for (const rec of Object.values(registry)) {
    if (rec.status !== "OPEN" || rec.entrySide !== "buy") continue;
    await withLiveOrderLock(() => reconcileStop(rec, now));
  }
}

setInterval(() => {
  reconcileExchangeStops().catch((err) => console.error("[LiveExecution] Backup-stop loop error:", err));
}, STOP_RECONCILE_MS).unref();

// Retry loop for exits that failed or couldn't be confirmed.
async function processPendingExits() {
  const now = Date.now();
  for (const rec of Object.values(registry)) {
    if (rec.status !== "EXIT_PENDING" || (rec.nextRetryAt && rec.nextRetryAt > now)) continue;
    await withLiveOrderLock(async () => {
      if (rec.status === "EXIT_PENDING") await attemptExit(rec);
    });
  }
}

export const PENDING_EXIT_INTERVAL_MS = 5000;
setInterval(() => {
  processPendingExits().catch((err) => console.error("[LiveExecution] Pending-exit loop error:", err));
}, PENDING_EXIT_INTERVAL_MS).unref();

// Exposed for tests; the interval above drives it in production.
export { processPendingExits };
