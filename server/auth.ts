import fs from "fs";
import path from "path";
import type { NextFunction, Request, Response } from "express";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import firebaseConfig from "../firebase-applet-config.json";
import { OWNER_EMAIL } from "../src/shared/owner";
import { isViewerOwnRoute } from "../src/shared/lookOnly";
import { deskUids } from "./scanner/deskState";

// Server-side authentication. Every /api route (except /api/health) and every
// WebSocket connection must present a Firebase ID token for a verified email
// that is on the ALLOWED_EMAILS allow-list. The React AuthGuard is only a UI
// convenience — this is the actual gate in front of the exchange keys.
//
// Look only (owner's ask, 23 Oct): emails on VIEWER_EMAILS may read the
// owner's desk and change nothing. Their requests are served as the owner's
// (the owner's uid, learned when the owner signs in), every request but a
// GET is refused, and so are the GETs for real money and live orders
// (OWNER_ONLY). Their sockets get the owner's events and can send none.
// Their own IPO alerts are their own (owner's ask, 23 Oct): the pop-up,
// Telegram and IPO routes act for the viewer's own uid (VIEWER_OWN_ROUTES),
// and the viewers who have signed in are kept (desk_viewers.json) so the
// server sends them the IPO alerts and nothing else, and nothing once the
// owner takes them off the list.

export interface AuthedRequest extends Request {
  user?: DecodedIdToken;
  /** Set for a look-only account: who it really is (req.user is then the owner's desk). */
  viewer?: { uid: string; email: string };
}

export type DeskRole = "owner" | "viewer";

if (!getApps().length) {
  // verifyIdToken only needs the project ID (it checks signatures against
  // Google's public certs), so no service-account credential is required.
  initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId });
}

function emailList(value: string | undefined): Set<string> {
  return new Set(
    (value || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

const allowedEmails = () => emailList(process.env.ALLOWED_EMAILS);
const viewerEmails = () => emailList(process.env.VIEWER_EMAILS);

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

/** The account a token belongs to: the owner (ALLOWED_EMAILS) or a look-only viewer (VIEWER_EMAILS). */
export function roleOf(decoded: Pick<DecodedIdToken, "email">): DeskRole {
  const email = decoded.email?.toLowerCase() ?? "";
  return allowedEmails().has(email) ? "owner" : "viewer";
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
  if (!email || decoded.email_verified !== true || !(allowed.has(email) || viewerEmails().has(email))) {
    throw new AuthError(403, "This account is not authorized to use this server.");
  }
  return decoded;
}

// ---------- the desk a viewer sees ----------

const OWNER_FILE = "desk_owner.json";
const dataDir = () => process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
let ownerUid: string | null | undefined;

/** The owner whose desk viewers see: the app's owner if allowed in, else the first allowed email. */
function deskOwnerEmail(): string {
  const allowed = [...allowedEmails()];
  return allowed.includes(OWNER_EMAIL) ? OWNER_EMAIL : allowed[0] ?? "";
}

/** Notes the owner's uid when the owner signs in (kept on disk, so viewers see the desk after a restart). */
function rememberOwner(decoded: DecodedIdToken): void {
  if (decoded.email?.toLowerCase() !== deskOwnerEmail() || ownerUid === decoded.uid) return;
  ownerUid = decoded.uid;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(path.join(dataDir(), OWNER_FILE), JSON.stringify({ uid: decoded.uid }), "utf8");
  } catch (err) {
    console.warn("[Auth] Couldn't save the desk owner:", err);
  }
}

/** The owner's uid: as last seen signing in, else saved, else the only desk the server holds; null until known. */
export function deskOwnerUid(): string | null {
  if (ownerUid === undefined) {
    try {
      const file = path.join(dataDir(), OWNER_FILE);
      ownerUid = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8"))?.uid ?? null) : null;
    } catch {
      ownerUid = null;
    }
  }
  if (ownerUid) return ownerUid;
  const desks = deskUids();
  return desks.length === 1 ? desks[0] : null;
}

/** The uid a verified token works on: its own for the owner, the owner's desk for a viewer (null until known). */
export function deskUidFor(decoded: DecodedIdToken): string | null {
  if (roleOf(decoded) === "owner") {
    rememberOwner(decoded);
    return decoded.uid;
  }
  rememberViewer(decoded);
  return deskOwnerUid();
}

/** Reads a viewer can't make: real money at CoinDCX and live orders. */
const OWNER_ONLY = ["/api/coindcx/balances", "/api/live/"];

// ---------- viewers who have signed in ----------

const VIEWERS_FILE = "desk_viewers.json";
let viewers: Record<string, string> | null = null;

function viewerList(): Record<string, string> {
  if (viewers) return viewers;
  try {
    const file = path.join(dataDir(), VIEWERS_FILE);
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    viewers = saved && typeof saved === "object" ? saved : {};
  } catch {
    viewers = {};
  }
  return viewers!;
}

/** Notes a viewer's uid and email (kept on disk): the alerts sent to viewers go only to those still on the list. */
function rememberViewer(decoded: DecodedIdToken): void {
  const email = decoded.email?.toLowerCase() ?? "";
  const list = viewerList();
  if (list[decoded.uid] === email) return;
  list[decoded.uid] = email;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(path.join(dataDir(), VIEWERS_FILE), JSON.stringify(list), "utf8");
  } catch (err) {
    console.warn("[Auth] Couldn't save the viewers:", err);
  }
}

/**
 * Whether a uid is a look-only account's: "active" while its email is on
 * VIEWER_EMAILS (and not the owner's list), "removed" once the owner has taken
 * it off; null for anyone else (the owner).
 */
export function viewerStatus(uid: string): "active" | "removed" | null {
  const email = viewerList()[uid];
  if (email === undefined) return null;
  return viewerEmails().has(email) && !allowedEmails().has(email) ? "active" : "removed";
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice(7).trim();
  return undefined;
}

const LOOK_ONLY = "This account can look at the desk but not change anything.";

// Express middleware — mount on /api after any public routes.
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  let decoded: DecodedIdToken;
  try {
    decoded = await verifyToken(bearerToken(req));
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    res.status(status).json({ success: false, error: (err as Error).message, code: "UNAUTHORIZED" });
    return;
  }
  if (roleOf(decoded) === "owner") {
    rememberOwner(decoded);
    req.user = decoded;
    next();
    return;
  }
  const route = (req.originalUrl || req.url || "").split("?")[0];
  rememberViewer(decoded);
  // Its own alerts and IPOs: as itself.
  if (isViewerOwnRoute(route)) {
    req.viewer = { uid: decoded.uid, email: decoded.email ?? "" };
    req.user = decoded;
    next();
    return;
  }
  if ((req.method !== "GET" && req.method !== "HEAD") || OWNER_ONLY.some((p) => route.startsWith(p))) {
    res.status(403).json({ success: false, error: LOOK_ONLY, code: "LOOK_ONLY" });
    return;
  }
  const owner = deskOwnerUid();
  if (!owner) {
    res.status(503).json({ success: false, error: "The desk isn't ready to view yet: its owner hasn't opened it since the update.", code: "NO_DESK" });
    return;
  }
  req.viewer = { uid: decoded.uid, email: decoded.email ?? "" };
  req.user = { ...decoded, uid: owner };
  next();
}

/** Who's asking (the app's sign-in guard lets a viewer in as look only). */
export function whoAmI(req: AuthedRequest): { role: DeskRole; email: string } {
  return req.viewer ? { role: "viewer", email: req.viewer.email } : { role: "owner", email: req.user?.email ?? "" };
}

/** Test hook. */
export function _resetAuth(): void {
  ownerUid = undefined;
  viewers = null;
}
