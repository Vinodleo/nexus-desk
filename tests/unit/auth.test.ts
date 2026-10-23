import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verifyIdToken = vi.fn();
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn(), getApps: () => [{}] }));
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }));

type Auth = typeof import("../../server/auth");
let auth: Auth;

let dir: string;

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-auth-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  vi.stubEnv("ALLOWED_EMAILS", "Owner@Example.com, second@example.com");
  vi.stubEnv("VIEWER_EMAILS", "Friend@Example.com");
  verifyIdToken.mockReset();
  vi.resetModules();
  auth = await import("../../server/auth");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const token = (claims: Record<string, unknown>) => verifyIdToken.mockResolvedValue({ uid: "u1", ...claims });

describe("verifyToken", () => {
  it("accepts a verified, allow-listed email (case-insensitive)", async () => {
    token({ email: "owner@example.com", email_verified: true });
    await expect(auth.verifyToken("t")).resolves.toMatchObject({ uid: "u1" });
  });

  it.each([
    ["missing token", undefined, {}, 401],
    ["email not on the allow-list", "t", { email: "stranger@example.com", email_verified: true }, 403],
    ["unverified email", "t", { email: "owner@example.com", email_verified: false }, 403],
    ["no email (anonymous)", "t", { email_verified: true }, 403],
  ])("rejects: %s", async (_n, tok, claims, status) => {
    token(claims);
    await expect(auth.verifyToken(tok as string | undefined)).rejects.toMatchObject({ status });
  });

  it("rejects a token Firebase won't verify", async () => {
    verifyIdToken.mockRejectedValue(new Error("expired"));
    await expect(auth.verifyToken("t")).rejects.toMatchObject({ status: 401 });
  });

  it("fails closed with 503 when ALLOWED_EMAILS is empty", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "");
    token({ email: "owner@example.com", email_verified: true });
    await expect(auth.verifyToken("t")).rejects.toMatchObject({ status: 503 });
  });
});

describe("requireAuth middleware", () => {
  const res = () => {
    const r: any = {};
    r.status = vi.fn(() => r);
    r.json = vi.fn(() => r);
    return r;
  };

  it("reads the Bearer token, sets req.user and calls next", async () => {
    token({ email: "second@example.com", email_verified: true });
    const req: any = { headers: { authorization: "Bearer abc" } };
    const next = vi.fn();
    await auth.requireAuth(req, res(), next);
    expect(verifyIdToken).toHaveBeenCalledWith("abc");
    expect(req.user.uid).toBe("u1");
    expect(next).toHaveBeenCalled();
  });

  it("responds 401 and does not call next without a token", async () => {
    const r = res();
    const next = vi.fn();
    await auth.requireAuth({ headers: {} } as any, r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("look only", () => {
  const res = () => {
    const r: any = {};
    r.status = vi.fn(() => r);
    r.json = vi.fn(() => r);
    return r;
  };
  const as = (uid: string, email: string) => verifyIdToken.mockResolvedValue({ uid, email, email_verified: true });
  const ask = async (method: string, url: string) => {
    const req: any = { headers: { authorization: "Bearer t" }, method, originalUrl: url };
    const r = res();
    const next = vi.fn();
    await auth.requireAuth(req, r, next);
    return { req, r, next };
  };
  /** The owner opens the app: the server learns whose desk viewers see. */
  const ownerSignsIn = async () => {
    as("owner-uid", "owner@example.com");
    await ask("GET", "/api/daemon/state");
  };

  it("lets a viewer in, and only a viewer or the owner", async () => {
    as("friend-uid", "friend@example.com");
    await expect(auth.verifyToken("t")).resolves.toMatchObject({ uid: "friend-uid" });
    expect(auth.roleOf({ email: "Friend@Example.com" })).toBe("viewer");
    expect(auth.roleOf({ email: "owner@example.com" })).toBe("owner");
    as("x", "stranger@example.com");
    await expect(auth.verifyToken("t")).rejects.toMatchObject({ status: 403 });
  });

  it("serves a viewer's reads as the owner's desk", async () => {
    await ownerSignsIn();
    as("friend-uid", "friend@example.com");
    const { req, next } = await ask("GET", "/api/daemon/state?x=1");
    expect(next).toHaveBeenCalled();
    expect(req.user.uid).toBe("owner-uid");
    expect(req.viewer).toEqual({ uid: "friend-uid", email: "friend@example.com" });
    expect(auth.whoAmI(req)).toEqual({ role: "viewer", email: "friend@example.com" });
  });

  it.each([
    ["opening a trade", "POST", "/api/execute-trade"],
    ["closing a trade", "POST", "/api/daemon/close"],
    ["changing the desk's settings", "POST", "/api/desk/state"],
    ["a live order", "POST", "/api/live/test-order"],
    ["anything but a read", "DELETE", "/api/anything"],
    ["the real CoinDCX balance", "GET", "/api/coindcx/balances"],
    ["the live orders' state", "GET", "/api/live/positions"],
  ])("refuses a viewer %s", async (_n, method, url) => {
    await ownerSignsIn();
    as("friend-uid", "friend@example.com");
    const { r, next } = await ask(method, url);
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: "LOOK_ONLY" }));
  });

  it.each([
    ["its phone's pop-ups", "POST", "/api/push/subscribe"],
    ["its own Telegram link", "GET", "/api/telegram"],
    ["linking its Telegram", "POST", "/api/telegram/link"],
    ["the IPOs, with its own 'I got shares'", "GET", "/api/ipos"],
    ["'I got shares'", "POST", "/api/ipos/held"],
  ])("lets a viewer set up %s as itself", async (_n, method, url) => {
    await ownerSignsIn();
    as("friend-uid", "friend@example.com");
    const { req, next } = await ask(method, url);
    expect(next).toHaveBeenCalled();
    expect(req.user.uid).toBe("friend-uid");
    expect(req.viewer).toEqual({ uid: "friend-uid", email: "friend@example.com" });
  });

  it("remembers who has looked, and who the owner has since taken off the list", async () => {
    await ownerSignsIn();
    as("friend-uid", "friend@example.com");
    await ask("GET", "/api/book");
    expect(auth.viewerStatus("friend-uid")).toBe("active");
    expect(auth.viewerStatus("owner-uid")).toBeNull();
    expect(auth.viewerStatus("nobody")).toBeNull();
    vi.stubEnv("VIEWER_EMAILS", "");
    expect(auth.viewerStatus("friend-uid")).toBe("removed");
    // Kept across a restart.
    vi.stubEnv("VIEWER_EMAILS", "friend@example.com");
    auth._resetAuth();
    expect(auth.viewerStatus("friend-uid")).toBe("active");
  });

  it("leaves the owner's own requests as they were", async () => {
    as("owner-uid", "owner@example.com");
    const { req, next } = await ask("POST", "/api/execute-trade");
    expect(next).toHaveBeenCalled();
    expect(req.user.uid).toBe("owner-uid");
    expect(req.viewer).toBeUndefined();
    expect(auth.whoAmI(req)).toEqual({ role: "owner", email: "owner@example.com" });
  });

  it("an email on both lists is the owner's", async () => {
    vi.stubEnv("VIEWER_EMAILS", "owner@example.com");
    as("owner-uid", "owner@example.com");
    const { next } = await ask("POST", "/api/execute-trade");
    expect(next).toHaveBeenCalled();
  });

  it("keeps the owner's desk across a restart, and says when it isn't known yet", async () => {
    as("friend-uid", "friend@example.com");
    const before = await ask("GET", "/api/daemon/state");
    expect(before.r.status).toHaveBeenCalledWith(503);
    expect(before.next).not.toHaveBeenCalled();

    await ownerSignsIn();
    vi.resetModules();
    auth = await import("../../server/auth");
    as("friend-uid", "friend@example.com");
    const after = await ask("GET", "/api/daemon/state");
    expect(after.req.user.uid).toBe("owner-uid");
  });

  it("before the owner signs in, takes the only desk the server holds", async () => {
    const { setDeskState } = await import("../../server/scanner/deskState");
    setDeskState("owner-uid", {} as any);
    as("friend-uid", "friend@example.com");
    const { req } = await ask("GET", "/api/daemon/state");
    expect(req.user.uid).toBe("owner-uid");
  });

  it("a second allowed account isn't the desk viewers see", async () => {
    as("second-uid", "second@example.com");
    await ask("GET", "/api/daemon/state");
    await ownerSignsIn();
    as("friend-uid", "friend@example.com");
    expect((await ask("GET", "/api/book")).req.user.uid).toBe("owner-uid");
  });

  it("gives a viewer's socket the owner's events", async () => {
    await ownerSignsIn();
    expect(auth.deskUidFor({ uid: "friend-uid", email: "friend@example.com" } as any)).toBe("owner-uid");
    expect(auth.deskUidFor({ uid: "owner-uid", email: "owner@example.com" } as any)).toBe("owner-uid");
  });
});
