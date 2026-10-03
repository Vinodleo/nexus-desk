import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Exec = typeof import("../../server/liveExecution");
let exec: Exec;
let dir: string;

// A fake CoinDCX: records create calls, answers status lookups from them, and
// can be told to fail specific create calls.
interface FakeExchange {
  creates: Array<Record<string, any>>;
  createBehaviour: Array<"ok" | "drop-after-accept" | "drop-before-accept" | "reject">;
  statusBehaviour: "from-orders" | "unreachable";
}
let ex: FakeExchange;

function installFakeExchange() {
  ex = { creates: [], createBehaviour: [], statusBehaviour: "from-orders" };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/exchange/v1/orders/create")) {
      const behaviour = ex.createBehaviour.shift() ?? "ok";
      if (behaviour === "drop-before-accept") throw new Error("socket hang up");
      if (behaviour === "reject") return new Response(JSON.stringify({ message: "Insufficient funds" }), { status: 422 });
      ex.creates.push(body);
      if (behaviour === "drop-after-accept") throw new Error("socket hang up");
      return new Response(JSON.stringify({ orders: [{ id: `ord${ex.creates.length}` }] }), { status: 200 });
    }
    if (url.endsWith("/exchange/v1/orders/status")) {
      if (ex.statusBehaviour === "unreachable") return new Response("{}", { status: 503 });
      const hit = ex.creates.find((c) => c.client_order_id === body.client_order_id);
      return hit
        ? new Response(JSON.stringify({ id: `found_${body.client_order_id}`, status: "filled" }), { status: 200 })
        : new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-exec-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  vi.stubEnv("COINDCX_API_KEY", "key");
  vi.stubEnv("COINDCX_API_SECRET", "secret");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  installFakeExchange();
  vi.resetModules();
  exec = await import("../../server/liveExecution");
  exec.registerLiveEntry({
    positionId: "pos-1",
    userId: "u1",
    market: "BTCINR",
    entrySide: "buy",
    quantity: 2,
    entryOrderId: "ord0",
    entryClientOrderId: "nx_open_pos1",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Make every pending exit due now and run the retry loop once.
async function runRetries(times = 1) {
  for (let i = 0; i < times; i++) {
    for (const p of exec.listLivePositions("u1")) if (p.nextRetryAt) p.nextRetryAt = 0;
    await exec.processPendingExits();
  }
}

describe("requestLiveExit", () => {
  it("sends one opposite-side market order with a deterministic client_order_id", async () => {
    const rec = await exec.requestLiveExit("pos-1", "STOP_LOSS");
    expect(rec?.status).toBe("CLOSED");
    expect(ex.creates).toHaveLength(1);
    expect(ex.creates[0]).toMatchObject({
      side: "sell",
      order_type: "market_order",
      market: "BTCINR",
      total_quantity: 2,
      client_order_id: "nx_exit_pos1",
    });
  });

  it("is idempotent under concurrent and repeated calls", async () => {
    const [a, b] = await Promise.all([exec.requestLiveExit("pos-1", "STOP_LOSS"), exec.requestLiveExit("pos-1", "MANUAL")]);
    await exec.requestLiveExit("pos-1", "MANUAL");
    expect(a?.status).toBe("CLOSED");
    expect(b?.status).toBe("CLOSED");
    expect(ex.creates).toHaveLength(1);
  });

  it("ignores unknown positions", async () => {
    expect(await exec.requestLiveExit("nope", "MANUAL")).toBeUndefined();
    expect(ex.creates).toHaveLength(0);
  });

  it("does not re-send when the exchange accepted but the response was lost", async () => {
    ex.createBehaviour = ["drop-after-accept"];
    const rec = await exec.requestLiveExit("pos-1", "STOP_LOSS");
    expect(rec?.status).toBe("EXIT_PENDING");
    await runRetries();
    expect(exec.getLivePosition("pos-1")?.status).toBe("CLOSED");
    expect(exec.getLivePosition("pos-1")?.exitOrderId).toBe("found_nx_exit_pos1");
    expect(ex.creates).toHaveLength(1); // looked up, not re-sent
  });

  it("re-sends when the exchange never received the order", async () => {
    ex.createBehaviour = ["drop-before-accept"];
    await exec.requestLiveExit("pos-1", "STOP_LOSS");
    await runRetries();
    expect(exec.getLivePosition("pos-1")?.status).toBe("CLOSED");
    expect(ex.creates).toHaveLength(1);
  });

  it("does not send while it can't confirm the previous attempt", async () => {
    ex.createBehaviour = ["drop-after-accept"];
    await exec.requestLiveExit("pos-1", "STOP_LOSS");
    ex.statusBehaviour = "unreachable";
    await runRetries(3);
    expect(exec.getLivePosition("pos-1")?.status).toBe("EXIT_PENDING");
    expect(ex.creates).toHaveLength(1);
    ex.statusBehaviour = "from-orders";
    await runRetries();
    expect(exec.getLivePosition("pos-1")?.status).toBe("CLOSED");
    expect(ex.creates).toHaveLength(1);
  });

  it("gives up after 10 attempts and marks EXIT_FAILED", async () => {
    ex.createBehaviour = Array(20).fill("reject");
    await exec.requestLiveExit("pos-1", "STOP_LOSS");
    await runRetries(15);
    const rec = exec.getLivePosition("pos-1");
    expect(rec?.status).toBe("EXIT_FAILED");
    expect(rec?.exitAttempts).toBe(10);
    expect(rec?.lastError).toMatch(/Insufficient funds/);
  });

  it("backs off exponentially between retries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    ex.createBehaviour = ["reject", "reject"];
    await exec.requestLiveExit("pos-1", "STOP_LOSS");
    expect(exec.getLivePosition("pos-1")?.nextRetryAt).toBe(1_000_000 + 5000);
    vi.setSystemTime(1_000_000 + 5000);
    await exec.processPendingExits();
    expect(exec.getLivePosition("pos-1")?.nextRetryAt).toBe(1_005_000 + 10000);
    // not due yet: nothing is sent
    await exec.processPendingExits();
    expect(exec.getLivePosition("pos-1")?.exitAttempts).toBe(2);
  });

  it("notifies the listener on every state change", async () => {
    const seen: string[] = [];
    exec.setLiveExitListener((r) => seen.push(r.status));
    ex.createBehaviour = ["reject"];
    await exec.requestLiveExit("pos-1", "STOP_LOSS");
    await runRetries();
    expect(seen).toEqual(["EXIT_PENDING", "CLOSED"]);
  });
});

describe("crash safety", () => {
  it("after a restart mid-send, looks the order up instead of re-sending", async () => {
    // Simulate: exit was being sent (marker saved) and the exchange got it,
    // then the process died before recording the result.
    ex.createBehaviour = ["drop-after-accept"];
    await exec.requestLiveExit("pos-1", "STOP_LOSS");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "live_positions.json"), "utf8"));
    expect(saved["pos-1"]).toMatchObject({ status: "EXIT_PENDING" });
    expect(saved["pos-1"].exitSentAt).toBeTruthy();

    vi.resetModules();
    const restarted: Exec = await import("../../server/liveExecution");
    await restarted.processPendingExits(); // nextRetryAt may be in the future; force it
    const rec = restarted.getLivePosition("pos-1")!;
    rec.nextRetryAt = 0;
    await restarted.processPendingExits();
    expect(restarted.getLivePosition("pos-1")?.status).toBe("CLOSED");
    expect(ex.creates).toHaveLength(1);
  });

  it("scopes listLivePositions to the owner", () => {
    expect(exec.listLivePositions("u1")).toHaveLength(1);
    expect(exec.listLivePositions("u2")).toHaveLength(0);
  });
});

describe("clientOrderId", () => {
  it("is deterministic, alphanumeric and at most 36 chars", () => {
    expect(exec.clientOrderId("exit", "pos-123")).toBe("nx_exit_pos123");
    expect(exec.clientOrderId("open", "a".repeat(80))).toHaveLength(36);
    expect(exec.clientOrderId("exit", "p/o$s")).toBe("nx_exit_pos");
  });
});

// ---------- the backup stop at CoinDCX ----------

// A fuller fake CoinDCX for stop orders: it keeps every order, answers
// status by id or client order id, cancels, and can be told to fill a stop.
interface Order {
  id: string;
  client_order_id: string;
  order_type: string;
  side: string;
  total_quantity: number;
  remaining_quantity: number;
  status: string;
  stop_price?: number;
  price_per_unit?: number;
  avg_price?: number;
}
interface StopExchange {
  orders: Order[];
  cancels: Array<Record<string, any>>;
  /** What the next stop_limit create does. */
  stopCreate: Array<"ok" | "refuse" | "drop-after-accept" | "server-error">;
  statusDown: boolean;
}
let sx: StopExchange;

function installStopExchange() {
  sx = { orders: [], cancels: [], stopCreate: [], statusDown: false };
  const find = (body: any) => sx.orders.find((o) => (body.id ? o.id === body.id : o.client_order_id === body.client_order_id));
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!url.includes("/exchange/v1/orders/")) return new Response("[]", { status: 503 }); // markets_details: no rules here
    const body = JSON.parse(String(init!.body));
    if (url.endsWith("/orders/create")) {
      const behaviour = body.order_type === "stop_limit" ? sx.stopCreate.shift() ?? "ok" : "ok";
      if (behaviour === "refuse") return new Response(JSON.stringify({ message: "Order type not supported for this market" }), { status: 422 });
      if (behaviour === "server-error") return new Response("{}", { status: 503 });
      const order: Order = {
        id: `o${sx.orders.length + 1}`, client_order_id: body.client_order_id, order_type: body.order_type, side: body.side,
        total_quantity: body.total_quantity, remaining_quantity: body.order_type === "market_order" ? 0 : body.total_quantity,
        status: body.order_type === "market_order" ? "filled" : "untriggered", stop_price: body.stop_price, price_per_unit: body.price_per_unit,
      };
      sx.orders.push(order);
      if (behaviour === "drop-after-accept") throw new Error("socket hang up");
      return new Response(JSON.stringify({ orders: [{ id: order.id }] }), { status: 200 });
    }
    if (url.endsWith("/orders/status")) {
      if (sx.statusDown) return new Response("{}", { status: 503 });
      const o = find(body);
      return o ? new Response(JSON.stringify(o), { status: 200 }) : new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }
    if (url.endsWith("/orders/cancel")) {
      sx.cancels.push(body);
      const o = find(body);
      if (!o) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      if (o.status !== "filled") o.status = o.remaining_quantity < o.total_quantity ? "partially_cancelled" : "cancelled";
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

/** The stop orders sent, and the market orders. */
const stops = () => sx.orders.filter((o) => o.order_type === "stop_limit");
const sells = () => sx.orders.filter((o) => o.order_type === "market_order");
/** CoinDCX fills (part of) the resting stop at `avg`. */
function fillStop(order: Order, quantity: number, avg: number) {
  order.remaining_quantity = Number((order.remaining_quantity - quantity).toFixed(8));
  order.status = order.remaining_quantity === 0 ? "filled" : "partially_filled";
  order.avg_price = avg;
}

describe("the backup stop at CoinDCX", () => {
  let serverStop: number | undefined;
  const closed: Array<[string, number]> = [];
  const refused: string[] = [];
  beforeEach(() => {
    installStopExchange();
    serverStop = 1000;
    closed.length = 0;
    refused.length = 0;
    exec.setStopSource((id) => (id === "pos-1" ? serverStop : undefined));
    exec.setExchangeStopListener({ closed: (rec, price) => closed.push([rec.positionId, price]), refused: (rec) => refused.push(rec.positionId) });
  });
  const t0 = Date.parse("2026-10-05T10:00:00Z");

  it("rests a stop-limit sell at CoinDCX just below the server's stop, once the guardian knows it, and only one", async () => {
    serverStop = undefined;
    await exec.reconcileExchangeStops(t0);
    expect(stops()).toHaveLength(0);
    serverStop = 1000;
    await exec.reconcileExchangeStops(t0);
    // 0.5% below the server's stop, selling down to 1% below that once triggered.
    expect(stops()).toEqual([expect.objectContaining({ side: "sell", total_quantity: 2, stop_price: 995, price_per_unit: 985.05, client_order_id: "nx_s1_pos1" })]);
    expect(exec.getLivePosition("pos-1")!.exchangeStop).toMatchObject({ status: "OPEN", orderId: "o1", stopPrice: 995, seq: 1 });
    await exec.reconcileExchangeStops(t0 + 15_000);
    expect(stops()).toHaveLength(1);
    // Kept across a restart.
    vi.resetModules();
    const restarted: Exec = await import("../../server/liveExecution");
    expect(restarted.getLivePosition("pos-1")!.exchangeStop).toMatchObject({ status: "OPEN", orderId: "o1" });
  });

  it("moves it up as the server's stop trails (cancelled first, then replaced), but not for small moves", async () => {
    await exec.reconcileExchangeStops(t0);
    serverStop = 1003; // +0.3%: left where it is
    await exec.reconcileExchangeStops(t0 + 15_000);
    expect(stops()).toHaveLength(1);
    serverStop = 1010;
    await exec.reconcileExchangeStops(t0 + 30_000);
    expect(sx.cancels).toEqual([expect.objectContaining({ id: "o1" })]);
    expect(stops().map((o) => [o.status, o.stop_price, o.client_order_id])).toEqual([
      ["cancelled", 995, "nx_s1_pos1"],
      ["untriggered", 1004.95, "nx_s2_pos1"],
    ]);
    expect(exec.getLivePosition("pos-1")!.exchangeStop).toMatchObject({ status: "OPEN", seq: 2, stopPrice: 1004.95 });
  });

  it("is cancelled before an exit sells, so the coins are free; if it already sold them, nothing more is sold", async () => {
    await exec.reconcileExchangeStops(t0);
    const rec = await exec.requestLiveExit("pos-1", "TAKE_PROFIT");
    expect(rec?.status).toBe("CLOSED");
    expect(sx.cancels).toEqual([expect.objectContaining({ id: "o1" })]);
    expect(sells()).toEqual([expect.objectContaining({ side: "sell", total_quantity: 2 })]);
    expect(rec?.exchangeStop?.status).toBe("CANCELLED");
  });

  it("an exit sells only what's left when the stop sold part first, and none when it sold it all", async () => {
    await exec.reconcileExchangeStops(t0);
    fillStop(stops()[0], 1.5, 990);
    const rec = await exec.requestLiveExit("pos-1", "STOP_LOSS");
    expect(rec?.status).toBe("CLOSED");
    expect(sells()).toEqual([expect.objectContaining({ total_quantity: 0.5 })]);

    exec.registerLiveEntry({ positionId: "pos-2", userId: "u1", market: "BTCINR", entrySide: "buy", quantity: 1, entryOrderId: "x", entryClientOrderId: "nx_open_pos2" });
    exec.setStopSource(() => 1000);
    await exec.reconcileExchangeStops(t0);
    fillStop(stops()[1], 1, 993);
    const all = await exec.requestLiveExit("pos-2", "STOP_LOSS");
    expect(all?.status).toBe("CLOSED");
    expect(all?.exitOrderId).toBe(stops()[1].id);
    expect(sells()).toHaveLength(1);
  });

  it("closes the position when CoinDCX's stop sold it (the server missed it, or was down), at CoinDCX's price", async () => {
    await exec.reconcileExchangeStops(t0);
    fillStop(stops()[0], 2, 992.5);
    // Checked a minute on, and again after a restart.
    await exec.reconcileExchangeStops(t0 + 30_000);
    expect(exec.getLivePosition("pos-1")!.status).toBe("OPEN");
    await exec.reconcileExchangeStops(t0 + 60_000);
    expect(exec.getLivePosition("pos-1")).toMatchObject({ status: "CLOSED", exitReason: "STOP_LOSS", exitOrderId: "o1" });
    expect(exec.getLivePosition("pos-1")!.exchangeStop!.status).toBe("FILLED");
    expect(closed).toEqual([["pos-1", 992.5]]);
    expect(sells()).toHaveLength(0);
  });

  it("when CoinDCX refuses stop orders, says so once, leaves the stop to the server, and tries again hours later", async () => {
    sx.stopCreate = ["refuse"];
    await exec.reconcileExchangeStops(t0);
    expect(exec.getLivePosition("pos-1")!.exchangeStop).toMatchObject({ status: "REFUSED", lastError: "Order type not supported for this market" });
    expect(refused).toEqual(["pos-1"]);
    await exec.reconcileExchangeStops(t0 + 60 * 60_000);
    expect(refused).toHaveLength(1);
    expect(stops()).toHaveLength(0);
    // Refused again 6 hours on: not said twice. Then accepted.
    sx.stopCreate = ["refuse"];
    await exec.reconcileExchangeStops(t0 + 6 * 60 * 60_000);
    expect(refused).toHaveLength(1);
    expect(exec.getLivePosition("pos-1")!.exchangeStop).toMatchObject({ status: "REFUSED", seq: 2 });
    await exec.reconcileExchangeStops(t0 + 12 * 60 * 60_000);
    expect(stops()).toHaveLength(1);
    expect(exec.getLivePosition("pos-1")!.exchangeStop).toMatchObject({ status: "OPEN", seq: 3 });
  });

  it("looks up a stop whose answer was lost before placing another, and places it again if it never arrived", async () => {
    sx.stopCreate = ["drop-after-accept"];
    await exec.reconcileExchangeStops(t0);
    expect(exec.getLivePosition("pos-1")!.exchangeStop!.status).toBe("PLACING");
    await exec.reconcileExchangeStops(t0 + 15_000);
    expect(stops()).toHaveLength(1);
    expect(exec.getLivePosition("pos-1")!.exchangeStop).toMatchObject({ status: "OPEN", orderId: "o1" });

    exec.registerLiveEntry({ positionId: "pos-3", userId: "u1", market: "BTCINR", entrySide: "buy", quantity: 1, entryOrderId: "x", entryClientOrderId: "nx_open_pos3" });
    exec.setStopSource(() => 1000);
    sx.stopCreate = ["server-error"];
    await exec.reconcileExchangeStops(t0 + 30_000);
    expect(exec.getLivePosition("pos-3")!.exchangeStop!.status).toBe("PLACING");
    await exec.reconcileExchangeStops(t0 + 45_000);
    expect(exec.getLivePosition("pos-3")!.exchangeStop).toMatchObject({ status: "OPEN", seq: 2, clientOrderId: "nx_s2_pos3" });
  });

  it("an exit waits while it can't confirm the stop was cancelled, rather than selling coins the stop holds", async () => {
    await exec.reconcileExchangeStops(t0);
    sx.statusDown = true;
    const rec = await exec.requestLiveExit("pos-1", "STOP_LOSS");
    expect(rec?.status).toBe("EXIT_PENDING");
    expect(sells()).toHaveLength(0);
    sx.statusDown = false;
    await runRetries();
    expect(exec.getLivePosition("pos-1")!.status).toBe("CLOSED");
    expect(sells()).toEqual([expect.objectContaining({ total_quantity: 2 })]);
  });
});
