import { Router, type Request, type Response } from "express";
import { validate, restoreBackupBody } from "../validation";
import { backupStatus, listBackups, requestRestore, restartForRestore, restoreState } from "../backup";

// Settings → Server → Restore a backup: the days there's a backup for, and
// putting one back (the server restarts to do it; server/backup.ts). Owner
// only: a look-only account is refused both (server/auth.ts).

export const router = Router();

router.get("/api/backups", async (_req: Request, res: Response) => {
  const { configured } = backupStatus();
  const state = restoreState();
  try {
    res.json({ success: true, configured, days: (await listBackups()) ?? [], restore: state.last, pending: state.pending });
  } catch (err: any) {
    res.status(502).json({ success: false, configured, error: `Couldn't list the backups: ${err?.message || err}`, restore: state.last, pending: state.pending });
  }
});

router.post("/api/backups/restore", validate({ body: restoreBackupBody }), async (req: Request, res: Response) => {
  const asked = await requestRestore(req.body.day);
  if (!asked.ok) {
    res.status(asked.status).json({ success: false, error: asked.error });
    return;
  }
  res.json({ success: true, day: req.body.day, requestedAt: asked.requestedAt });
  restartForRestore();
});
