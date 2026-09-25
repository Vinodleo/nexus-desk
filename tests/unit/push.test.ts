import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Trade pop-ups: the phone subscribes, and the server pushes when a trade
// opens (by the server's autopilot, or first seen from the app).

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-push-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const sent: { endpoint: string; payload: any }[] = [];
let failWith: number | null = null;
vi.mock("web-push", async (orig) => {
  const real = (await orig()) as any;
  const lib = {
    ...real.default,
    generateVAPIDKeys: real.default.generateVAPIDKeys,
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }, payload: string) => {
      if (failWith) throw Object.assign(new Error("gone"), { statusCode: failWith });
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return {};
    }),
  };
  return { default: lib, ...lib };
});

const sub = (n: number) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: "BPk", auth: "au" } });

let base: string;
let server: Server;
let push: typeof import("../../server/push");
let guardian: typeof import("../../server/guardian");

beforeAll(async () => {
  push = await import("../../server/push");
  guardian = await import("../../server/guardian");
  const { router } = await import("../../server/routes/push");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { uid: String(req.headers["x-uid"] || "u1") };
    next();
  });
  app.use(router);
  app.use(guardian.router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  sent.length = 0;
  failWith = null;
  guardian._resetGuardian();
});

const post = (p: string, body: unknown) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("subscribing", () => {
  it("hands out one key pair, kept on disk", async () => {
    const key = (await (await fetch(`${base}/api/push/key`)).json()).publicKey;
    expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    push._resetPush();
    expect(push.pushPublicKey()).toBe(key);
  });

  it("keeps each device, forgets it on unsubscribe, and refuses what isn't a push subscription", async () => {
    expect((await post("/api/push/subscribe", { subscription: sub(1) })).status).toBe(200);
    expect(push.hasSubscription("u1", sub(1).endpoint)).toBe(true);
    expect((await (await post("/api/push/status", { endpoint: sub(1).endpoint })).json()).subscribed).toBe(true);
    expect((await post("/api/push/subscribe", { subscription: { endpoint: "http://not-https", keys: { p256dh: "a", auth: "b" } } })).status).toBe(400);
    expect((await post("/api/push/unsubscribe", { endpoint: sub(1).endpoint })).status).toBe(200);
    expect(push.hasSubscription("u1", sub(1).endpoint)).toBe(false);
  });
});

describe("sending", () => {
  it("reaches every device of the user, and forgets devices that have gone away", async () => {
    push.addSubscription("u2", sub(2));
    push.addSubscription("u2", sub(3));
    expect(await push.notifyUser("u2", { title: "t", body: "b" })).toBe(2);
    expect(await push.notifyUser("nobody", { title: "t", body: "b" })).toBe(0);
    failWith = 410;
    expect(await push.notifyUser("u2", { title: "t", body: "b" })).toBe(0);
    expect(push.hasSubscription("u2", sub(2).endpoint)).toBe(false);
  });

  it("says what was bought, at what, with its stop and target", () => {
    const m = push.tradeOpenedMessage(
      { id: "p1", symbol: "SOL/INR", direction: "LONG", quantity: 0.86, entryPrice: 11600, stopLoss: 11450, takeProfit: 11900, setupName: "Chen Conservative Trend" },
      "server"
    );
    expect(m.title).toBe("Bought SOL/INR");
    expect(m.body).toBe("0.86 @ ₹11,600 (₹9,976) · stop ₹11,450 · target ₹11,900 · Chen Conservative Trend · opened by the server");
    expect(m.tag).toBe("open-p1");
  });
});

describe("when a trade closes", () => {
  it("says the result, why it closed, the price, how long it was held and the trader", () => {
    const m = push.tradeClosedMessage({
      positionId: "p9", symbol: "SOL/INR", direction: "LONG", quantity: 0.86, exitPrice: 11650, realizedPnl: 42.1,
      exitReason: "TRAILING_STOP", holdingDurationMinutes: 38, setupName: "Chen Conservative Trend",
    });
    expect(m).toEqual({
      title: "SOL/INR closed +₹42.1",
      body: "Trailing stop · sold 0.86 @ ₹11,650 · held 38 min · Chen Conservative Trend",
      tag: "close-p9",
      url: "/",
    });
    expect(push.tradeClosedMessage({ positionId: "p", symbol: "ZEC/INR", direction: "LONG", quantity: 0.061, exitPrice: 151230, realizedPnl: -178.28, exitReason: "STOP_LOSS", holdingDurationMinutes: 75 }).title).toBe("ZEC/INR closed −₹178.28");
    expect(push.tradeClosedMessage({ positionId: "p", symbol: "A/INR", direction: "LONG", quantity: 1, exitPrice: 1, realizedPnl: 1, exitReason: "EXPIRY_TIME", holdingDurationMinutes: 75 }).body).toMatch(/held 1 h 15 min/);
  });

  it("pops up when the guardian closes it", async () => {
    push.addSubscription("u3", sub(6));
    guardian.daemonPositions.set("g1", {
      id: "g1", userId: "u3", symbol: "SOL/INR", direction: "LONG", entryPrice: 100, currentPrice: 100,
      quantity: 2, stopLoss: 99, takeProfit: 110, openTime: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    guardian.evaluateDaemonPositions("SOL/INR", 98.5);
    await vi.waitFor(() =>
      expect(sent.find((s) => s.payload.tag === "close-g1")?.payload).toMatchObject({ title: expect.stringMatching(/^SOL\/INR closed −₹/), body: expect.stringMatching(/^Stop loss · sold 2 @ ₹98.5/) })
    );
  });
});

describe("when a trade opens", () => {
  const position = (over: Record<string, unknown> = {}) => ({
    id: "app-1", symbol: "SOL/INR", direction: "LONG", entryPrice: 100, quantity: 2, stopLoss: 98, takeProfit: 104,
    openTime: new Date().toISOString(), ...over,
  });

  it("pops up for a position the server's autopilot opens", async () => {
    push.addSubscription("u1", sub(4));
    guardian.openServerPosition("u1", { ...position({ id: "srv-1" }), currentPrice: 100 } as any);
    await vi.waitFor(() => expect(sent.some((s) => s.payload.title === "Bought SOL/INR" && /opened by the server/.test(s.payload.body))).toBe(true));
  });

  it("pops up once for a position the app just opened, not for old ones re-sent", async () => {
    push.addSubscription("u1", sub(5));
    await post("/api/daemon/sync-positions", { positions: [position()] });
    await post("/api/daemon/sync-positions", { positions: [position()] });
    await vi.waitFor(() => expect(sent.filter((s) => s.payload.tag === "open-app-1" && s.endpoint === sub(5).endpoint)).toHaveLength(1));
    sent.length = 0;
    await post("/api/daemon/sync-positions", { positions: [position({ id: "old-1", openTime: new Date(Date.now() - 60 * 60_000).toISOString() })] });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
  });
});
