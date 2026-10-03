import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The guardian and the backup stops at CoinDCX together: a live long's
// backup stop follows the guardian's stop, and when CoinDCX's stop sells the
// position (the server missed it), the guardian closes it at CoinDCX's price
// without selling again.

let dir: string;
let guardian: typeof import("../../server/guardian");
let exec: typeof import("../../server/liveExecution");
const orders: Array<Record<string, any>> = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-guardian-stop-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  vi.stubEnv("COINDCX_API_KEY", "key");
  vi.stubEnv("COINDCX_API_SECRET", "secret");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!url.includes("/exchange/v1/orders/")) return new Response("[]", { status: 503 });
    const body = JSON.parse(String(init!.body));
    if (url.endsWith("/orders/create")) {
      orders.push({ ...body, id: `o${orders.length + 1}`, status: "untriggered", remaining_quantity: body.total_quantity });
      return new Response(JSON.stringify({ orders: [{ id: `o${orders.length}` }] }), { status: 200 });
    }
    if (url.endsWith("/orders/status")) {
      const o = orders.find((x) => x.id === body.id || x.client_order_id === body.client_order_id);
      return o ? new Response(JSON.stringify(o), { status: 200 }) : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 200 });
  });
  guardian = await import("../../server/guardian");
  exec = await import("../../server/liveExecution");
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

const position = (id: string, live: boolean) => ({
  id, userId: "u1", symbol: "BTC/INR", direction: "LONG" as const, entryPrice: 1000, currentPrice: 1000, quantity: 2,
  stopLoss: 900, takeProfit: 1200, openTime: new Date().toISOString(), isLiveOrder: live,
});

describe("the guardian with backup stops at CoinDCX", () => {
  it("rests a backup stop under a live long's guardian stop, none for a paper one, and closes the trade CoinDCX's stop sold", async () => {
    const now = Date.now();
    exec.registerLiveEntry({ positionId: "live1", userId: "u1", market: "BTCINR", entrySide: "buy", quantity: 2, entryOrderId: "e1", entryClientOrderId: "nx_open_live1" });
    guardian.daemonPositions.set("live1", position("live1", true) as never);
    guardian.daemonPositions.set("paper1", position("paper1", false) as never);
    await exec.reconcileExchangeStops(now);
    // 0.5% under the guardian's 900.
    expect(orders).toEqual([expect.objectContaining({ order_type: "stop_limit", side: "sell", market: "BTCINR", total_quantity: 2, stop_price: 895.5 })]);

    // CoinDCX's stop sold it at 893 while the server wasn't looking.
    Object.assign(orders[0], { status: "filled", remaining_quantity: 0, avg_price: 893 });
    await exec.reconcileExchangeStops(now + 60_000);
    expect(guardian.daemonPositions.has("live1")).toBe(false);
    expect(guardian.closedTradesFor("u1")[0]).toMatchObject({ positionId: "live1", exitPrice: 893, exitReason: "STOP_LOSS" });
    expect(exec.getLivePosition("live1")?.status).toBe("CLOSED");
    // No second sell: the only order sent is the stop.
    expect(orders).toHaveLength(1);
    expect(guardian.daemonPositions.has("paper1")).toBe(true);
  });
});
