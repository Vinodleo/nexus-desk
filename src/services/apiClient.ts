import { auth } from "./firebase";
import { isViewerOwnRoute } from "../shared/lookOnly";

// All calls to our own /api routes go through here so they carry the
// signed-in user's Firebase ID token; the server rejects anything without one.

async function idToken(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
}

/** What a look-only account is told when something would change the desk. */
export const LOOK_ONLY_TEXT = "This account can look at the desk but not change anything.";

let lookOnly = false;

/**
 * A look-only account (the server's VIEWER_EMAILS): from now on requests that
 * would change something aren't sent (the server refuses them anyway), so the
 * app's background saves don't fail one by one. Its own alerts and IPOs
 * (VIEWER_OWN_ROUTES) still go.
 */
export function setLookOnly(on: boolean): void {
  lookOnly = on;
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (lookOnly && (init.method ?? "GET").toUpperCase() !== "GET" && !isViewerOwnRoute(input)) {
    return new Response(JSON.stringify({ success: false, error: LOOK_ONLY_TEXT, code: "LOOK_ONLY" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  const headers = new Headers(init.headers);
  const token = await idToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

// Sends the AUTH handshake the backend WebSocket requires before it will
// stream anything to this socket. Call from the socket's onopen handler.
export async function authenticateSocket(ws: WebSocket): Promise<void> {
  const token = await idToken();
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "AUTH", token }));
  }
}
