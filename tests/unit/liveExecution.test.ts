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
