import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Settings → Desk: Read access: the owner lists, adds and removes the accounts
// that may look at the desk; one removed has its live updates cut at once.

vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn(), getApps: () => [{}] }));
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken: vi.fn() }) }));
const closeSocketsOf = vi.fn();
vi.mock("../../server/realtime", () => ({ closeSocketsOf: (email: string) => closeSocketsOf(email) }));

let base: string;
let server: Server;
let dir: string;

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-viewers-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  vi.stubEnv("ALLOWED_EMAILS", "owner@example.com");
  vi.stubEnv("VIEWER_EMAILS", "friend@example.com");
  const { router } = await import("../../server/routes/viewers");
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = async (url: string, body: unknown) => {
  const res = await fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

describe("read access", () => {
  it("lists, adds and removes, cutting a removed one's live updates", async () => {
    const listed = await (await fetch(`${base}/api/viewers`)).json();
    expect(listed).toEqual({ success: true, viewers: [{ email: "friend@example.com", signedIn: false }], max: 20 });

    const added = await post("/api/viewers", { email: "New@Example.com" });
    expect(added.status).toBe(200);
    expect(added.body.viewers.map((v: { email: string }) => v.email)).toEqual(["friend@example.com", "new@example.com"]);

    const removed = await post("/api/viewers/remove", { email: "friend@example.com" });
    expect(removed.body.viewers.map((v: { email: string }) => v.email)).toEqual(["new@example.com"]);
    expect(closeSocketsOf).toHaveBeenCalledWith("friend@example.com");
    // Removing one not on the list closes nothing.
    closeSocketsOf.mockClear();
    await post("/api/viewers/remove", { email: "nobody@example.com" });
    expect(closeSocketsOf).not.toHaveBeenCalled();
  });

  it("says why it couldn't add one", async () => {
    expect(await post("/api/viewers", { email: "owner@example.com" })).toMatchObject({ status: 400, body: { code: "NOT_ADDED" } });
    expect(await post("/api/viewers", { email: "not an email" })).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
  });
});
