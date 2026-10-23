import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The live updates' sockets: an account whose read access is removed has its open
// sockets closed at once (Settings → Desk: Read access).

vi.mock("../../server/auth", () => ({
  verifyToken: vi.fn(async (token: string) => ({ uid: `${token}-uid`, email: `${token}@Example.com` })),
  deskUidFor: vi.fn(() => "owner-uid"),
}));
const { attachWebSocketServer, closeSocketsOf } = await import("../../server/realtime");

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer();
  attachWebSocketServer(server);
  await new Promise<void>((r) => server.listen(0, r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** A socket signed in as `who`, once the server has said AUTH_OK. */
const signedIn = (who: string) =>
  new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(url);
    ws.on("open", () => ws.send(JSON.stringify({ type: "AUTH", token: who })));
    ws.on("message", (raw) => JSON.parse(String(raw)).type === "AUTH_OK" && resolve(ws));
  });
const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));

describe("closing a removed account's sockets", () => {
  it("closes that account's sockets and leaves the others", async () => {
    const friend = await signedIn("friend");
    const owner = await signedIn("owner");
    const friendClosed = closed(friend);
    expect(closeSocketsOf("FRIEND@example.com ")).toBe(1);
    expect(await friendClosed).toBe(4403);
    expect(owner.readyState).toBe(WebSocket.OPEN);
    owner.close();
  });
});
