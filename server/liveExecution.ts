import crypto from "crypto";
import fs from "fs";
import path from "path";
import { recordLiveOrder, withLiveOrderLock } from "./liveOrderGuard";

// Server-owned lifecycle for LIVE CoinDCX positions.
//
// Every live entry is registered here (by the client's position id) when the
// exchange accepts it. Exits are always sent by the server — whether the
// position guardian hits a stop/target/expiry or the user closes it — so a
// closed or sleeping browser can never leave a real position open.
//
// Exits are idempotent: each position has one deterministic exit
// client_order_id. Before re-sending a failed exit we ask CoinDCX whether an
// order with that client_order_id already exists, and only re-send if it
// doesn't. That relies on /exchange/v1/orders/status accepting
// `client_order_id` — verify against CoinDCX's docs before going live.

type Side = "buy" | "sell";

export type LivePositionStatus = "OPEN" | "EXIT_PENDING" | "CLOSED" | "EXIT_FAILED";

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

async function signedPost(endpoint: string, body: Record<string, unknown>) {
  const { apiKey, apiSecret } = credentials();
  if (!apiKey || !apiSecret) throw new Error("CoinDCX API credentials are not configured on the server");
  const payload = JSON.stringify({ ...body, timestamp: Date.now() });
  const signature = crypto.createHmac("sha256", apiSecret).update(payload).digest("hex");
  const response = await fetch(`https://api.coindcx.com${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AUTH-APIKEY": apiKey, "X-AUTH-SIGNATURE": signature },
    body: payload,
  });
  const data: any = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

// CoinDCX client_order_id: keep it short and alphanumeric/underscore.
export function clientOrderId(kind: "open" | "exit", positionId: string): string {
  return `nx_${kind}_${positionId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 36);
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
  rec.exitClientOrderId = rec.exitClientOrderId || clientOrderId("exit", rec.positionId);

  // If an earlier send may have reached the exchange (even one interrupted by
  // a crash), check before sending again.
  if (rec.exitSentAt) {
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
