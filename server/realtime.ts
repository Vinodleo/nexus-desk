import type { Server } from "http";
import WebSocket, { WebSocketServer } from "ws";
import { verifyToken } from "./auth";

// WebSocket fan-out. A client must send {"type":"AUTH","token":"<Firebase ID
// token>"} as its first message within 10s; until then it receives nothing,
// and it is closed if the token is missing or not allowed.

type AuthedSocket = WebSocket & { isAuthed?: boolean; uid?: string };

let wss: WebSocketServer | null = null;

export function attachWebSocketServer(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server });

  wss.on("connection", (socket: AuthedSocket) => {
    socket.isAuthed = false;
    const authTimer = setTimeout(() => {
      if (!socket.isAuthed) socket.close(4401, "Authentication timeout");
    }, 10000);

    socket.on("message", async (raw) => {
      if (socket.isAuthed) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type !== "AUTH") throw new Error("Expected AUTH message");
        const decoded = await verifyToken(msg.token);
        socket.uid = decoded.uid;
        socket.isAuthed = true;
        clearTimeout(authTimer);
        socket.send(JSON.stringify({ type: "AUTH_OK" }));
      } catch {
        clearTimeout(authTimer);
        socket.close(4403, "Unauthorized");
      }
    });
    socket.on("close", () => clearTimeout(authTimer));
  });

  return wss;
}

// Market data: every authenticated client.
export function broadcast(message: unknown) {
  if (!wss) return;
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && (client as AuthedSocket).isAuthed) {
      client.send(payload);
    }
  });
}

// Per-user events (guardian closes, live exit status): only that user's sockets.
export function broadcastToUser(uid: string | undefined, message: unknown) {
  if (!wss || !uid) return;
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    const s = client as AuthedSocket;
    if (s.readyState === WebSocket.OPEN && s.isAuthed && s.uid === uid) s.send(payload);
  });
}

// Latest real CoinDCX price per symbol ("BTC/INR"), fed by the market relay
// and used as the server-side reference price for live orders.
export const currentPrices: Record<string, number> = {};
