import type { NextFunction, Request, Response } from "express";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import firebaseConfig from "../firebase-applet-config.json";

// Server-side authentication. Every /api route (except /api/health) and every
// WebSocket connection must present a Firebase ID token for a verified email
// that is on the ALLOWED_EMAILS allow-list. The React AuthGuard is only a UI
// convenience — this is the actual gate in front of the exchange keys.

export interface AuthedRequest extends Request {
  user?: DecodedIdToken;
}

if (!getApps().length) {
  // verifyIdToken only needs the project ID (it checks signatures against
  // Google's public certs), so no service-account credential is required.
  initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId });
}

function allowedEmails(): Set<string> {
  return new Set(
    (process.env.ALLOWED_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

if (allowedEmails().size === 0) {
  console.warn(
    "[Auth] ALLOWED_EMAILS is not set — every authenticated /api request and WebSocket will be rejected (fail-closed)."
  );
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function verifyToken(token: string | undefined | null): Promise<DecodedIdToken> {
  if (!token) throw new AuthError(401, "Missing Firebase ID token");

  let decoded: DecodedIdToken;
  try {
    decoded = await getAuth().verifyIdToken(token);
  } catch {
    throw new AuthError(401, "Invalid or expired Firebase ID token");
  }

  const allowed = allowedEmails();
  if (allowed.size === 0) {
    throw new AuthError(503, "Server has no ALLOWED_EMAILS configured; access is disabled.");
  }
  const email = decoded.email?.toLowerCase();
  if (!email || decoded.email_verified !== true || !allowed.has(email)) {
    throw new AuthError(403, "This account is not authorized to use this server.");
  }
  return decoded;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice(7).trim();
  return undefined;
}

// Express middleware — mount on /api after any public routes.
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    req.user = await verifyToken(bearerToken(req));
    next();
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    res.status(status).json({ success: false, error: (err as Error).message, code: "UNAUTHORIZED" });
  }
}
