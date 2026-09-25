import express, { type Request, type Response } from "express";
import compression from "compression";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

import { requireAuth } from "./server/auth";
import { attachWebSocketServer } from "./server/realtime";
import { startCoinDcxRelay } from "./server/marketRelay";
import {
  router as guardianRouter,
  loadDaemonStateFromDisk,
  saveDaemonStateToDisk,
  startExpiryGuard,
} from "./server/guardian";
import { router as zerodhaRouter } from "./server/routes/zerodha";
import { router as coindcxRouter } from "./server/routes/coindcx";
import { router as tradingRouter } from "./server/routes/trading";
import { router as agentsRouter } from "./server/routes/agents";
import { router as scannerRouter } from "./server/routes/scanner";
import { router as pushRouter } from "./server/routes/push";
import { loadDeskStates } from "./server/scanner/deskState";
import { saveScannerState, scannerHeartbeat, startServerScanner } from "./server/scanner/scannerService";
import { hostStatus, warnIfStateIsTemporary } from "./server/hostStatus";
import { startStockPrices } from "./server/stockPrices";
import { startQuotes } from "./server/quotes";
import { angelStatus } from "./server/angelOne";

// Entry point: builds the Express app, mounts the route modules behind
// Firebase auth, and starts the WebSocket fan-out, the CoinDCX price relay and
// the 24/7 position guardian.

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Compress responses (the app, its assets and API replies); cuts the
// server's outgoing data, which some hosts bill for. WebSockets aren't affected.
app.use(compression());
app.use(express.json());

// Unauthenticated, for uptime monitors and container health checks: 503 when
// the scanner's candle-close loop has stopped firing.
app.get("/api/health", (_req: Request, res: Response) => {
  const scanner = scannerHeartbeat();
  res.status(scanner.stalled ? 503 : 200).json({
    status: scanner.stalled ? "scanner-stalled" : "ok",
    version: "2.0",
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    uptimeSec: hostStatus().uptimeSec,
    scanner: { lastTickAt: scanner.lastTickAt, lastCycleDoneAt: scanner.lastCycleDoneAt },
    timestamp: new Date().toISOString(),
  });
});

// Every other /api route requires a verified, allow-listed Firebase user
// (see server/auth.ts).
app.use("/api", requireAuth);

app.use(zerodhaRouter);
app.use(coindcxRouter);
app.use(tradingRouter);
app.use(guardianRouter);
app.use(agentsRouter);
app.use(scannerRouter);
app.use(pushRouter);

// Where the server runs and whether its saved state survives restarts.
app.get("/api/server/status", (_req: Request, res: Response) => {
  res.json({ success: true, ...hostStatus(), scanner: scannerHeartbeat(), angelOne: angelStatus() });
});

// Unknown API paths get a JSON 404 instead of falling through to the SPA's
// index.html (which answered 200 with a web page).
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: "Not found", code: "NOT_FOUND" });
});

// Restore guardian state before anything can tick, and flush it on shutdown.
loadDaemonStateFromDisk();
loadDeskStates();
warnIfStateIsTemporary();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[Daemon] ${signal} received. Flushing state to disk...`);
    saveDaemonStateToDisk();
    saveScannerState();
    process.exit(0);
  });
}

// Start server with Vite middleware in dev or static files in production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Self-Learning Trading Bot v2.0 Server running on port ${PORT}`);
  });

  attachWebSocketServer(server);
  startCoinDcxRelay();
  startExpiryGuard();
  startServerScanner();
  startStockPrices();
  startQuotes();
}

startServer();
