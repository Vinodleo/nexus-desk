import { auth } from "./firebase";

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

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
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
