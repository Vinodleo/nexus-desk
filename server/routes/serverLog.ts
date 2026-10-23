import { Router, type Request, type Response } from "express";
import { validate, serverLogQuery } from "../validation";
import { readLog } from "../serverLog";

// Settings → Server → Recent log: the server's latest lines, newest first
// (server/serverLog.ts). Owner only: a look-only account is refused it
// (server/auth.ts).

export const router = Router();

router.get("/api/server-log", validate({ query: serverLogQuery }), (req: Request, res: Response) => {
  const limit = Number(req.query.limit ?? 200);
  res.json({ success: true, lines: readLog(limit, req.query.problems === "1") });
});
