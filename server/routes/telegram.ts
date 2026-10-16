import { Router, type Request, type Response } from "express";
import type { AuthedRequest } from "../auth";
import { sendTelegram, startTelegramLink, telegramStatus, unlinkTelegram } from "../telegram";

// Settings → Connections → Telegram: whether a bot is set up and this user's
// chat linked, a link to open the bot with a one-time code, a test, unlink.

export const router = Router();

const uidOf = (req: Request) => (req as AuthedRequest).user!.uid;

router.get("/api/telegram", (req: Request, res: Response) => {
  res.json({ success: true, ...telegramStatus(uidOf(req)) });
});

router.post("/api/telegram/link", async (req: Request, res: Response) => {
  const got = await startTelegramLink(uidOf(req));
  if ("error" in got) res.status(400).json({ success: false, error: got.error });
  else res.json({ success: true, url: got.url });
});

router.post("/api/telegram/test", async (req: Request, res: Response) => {
  const sent = await sendTelegram(uidOf(req), { title: "Test from Nexus Desk", body: "Trade alerts will arrive like this." });
  if (sent) res.json({ success: true });
  else res.status(400).json({ success: false, error: "Telegram didn't take it. Link it again from Settings." });
});

router.post("/api/telegram/unlink", (req: Request, res: Response) => {
  unlinkTelegram(uidOf(req));
  res.json({ success: true });
});
