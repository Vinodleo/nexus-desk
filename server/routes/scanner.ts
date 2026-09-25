import { Router, type Request, type Response } from "express";
import type { AuthedRequest } from "../auth";
import type { PromotedLabModel } from "../../src/types";
import { validate, deskStateBody, scannerReportsQuery } from "../validation";
import { setDeskState } from "../scanner/deskState";
import { coinActivity, exitEdgeTable, reportsSince, scanNow, scannerStatus, shadowsFor } from "../scanner/scannerService";
import { MIN_TRADING_ACTIVITY } from "../../src/services/tradingActivity";
import { expectancyRows, MIN_MARKET_TRADES } from "../../src/services/exitExpectancy";
import { getEvents } from "../eventCalendar";
import { PAUSE_AFTER_MS, eventWindowAt } from "../../src/shared/eventCalendar";

// The app's side of the server scanner: it sends its desk settings, and
// picks up scan results and tracked setups.

export const router = Router();

const uidOf = (req: Request) => (req as AuthedRequest).user!.uid;

// Settings the scanner needs (limits, equity, P&L, drills, quarantines, Lab settings).
router.post("/api/desk/state", validate({ body: deskStateBody }), (req: Request, res: Response) => {
  const body = req.body;
  setDeskState(uidOf(req), { ...body, promotedModel: (body.promotedModel ?? null) as PromotedLabModel | null });
  res.json({ success: true, status: scannerStatus(uidOf(req)) });
});

// Whether the server is scanning, and every scan since `since` (ms).
router.get("/api/scanner/reports", validate({ query: scannerReportsQuery }), (req: Request, res: Response) => {
  const uid = uidOf(req);
  const since = Number(req.query.since) || 0;
  res.json({ success: true, status: scannerStatus(uid), reports: reportsSince(uid, since) });
});

// Every setup the server is following or has followed (for the Learning tab).
router.get("/api/scanner/shadows", (req: Request, res: Response) => {
  res.json({ success: true, shadows: shadowsFor(uidOf(req)) });
});

// How each trader's setups have done lately with your exits (the Book's breakdown).
router.get("/api/scanner/exit-edge", (req: Request, res: Response) => {
  const table = exitEdgeTable(uidOf(req));
  const activity = { minActivity: MIN_TRADING_ACTIVITY, coins: coinActivity() };
  if (!table) return res.json({ success: true, table: null, activity });
  res.json({
    success: true,
    table: { profile: table.profile, measuredAt: table.measuredAt, symbols: table.symbols, minMarketTrades: MIN_MARKET_TRADES, rows: expectancyRows(table) },
    activity,
  });
});

// "Scan now": every coin, immediately.
router.post("/api/scanner/scan-now", async (req: Request, res: Response) => {
  try {
    const report = await scanNow(uidOf(req));
    if (!report) return res.status(409).json({ success: false, error: "The app hasn't sent its settings yet." });
    res.json({ success: true, report });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || "Scan failed" });
  }
});

// This week's high-impact events still to come (or under way), and whether a
// news pause is on now.
router.get("/api/events", async (_req: Request, res: Response) => {
  const now = Date.now();
  const events = await getEvents(now);
  res.json({ success: true, events: events.filter((e) => e.at + PAUSE_AFTER_MS >= now), window: eventWindowAt(events, now) });
});
