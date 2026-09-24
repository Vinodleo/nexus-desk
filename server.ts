import express, { type Request, type Response } from "express";
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
import { loadDeskStates } from "./server/scanner/deskState";
import { startServerScanner } from "./server/scanner/scannerService";

// Entry point: builds the Express app, mounts the route modules behind
// Firebase auth, and starts the WebSocket fan-out, the CoinDCX price relay and
// the 24/7 position guardian.

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    version: "2.0",
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
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

// Unknown API paths get a JSON 404 instead of falling through to the SPA's
// index.html (which answered 200 with a web page).
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: "Not found", code: "NOT_FOUND" });
});

// Restore guardian state before anything can tick, and flush it on shutdown.
loadDaemonStateFromDisk();
loadDeskStates();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[Daemon] ${signal} received. Flushing state to disk...`);
    saveDaemonStateToDisk();
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
}

startServer();
