import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verifyIdToken = vi.fn();
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn(), getApps: () => [{}] }));
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }));

type Auth = typeof import("../../server/auth");
let auth: Auth;

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("ALLOWED_EMAILS", "Owner@Example.com, second@example.com");
  verifyIdToken.mockReset();
  vi.resetModules();
  auth = await import("../../server/auth");
});

afterEach(() => vi.unstubAllEnvs());

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
