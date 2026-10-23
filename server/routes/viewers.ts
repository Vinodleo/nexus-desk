import { Router, type Request, type Response } from "express";
import { validate, viewerEmailBody } from "../validation";
import { addViewer, listViewers, MAX_VIEWERS, removeViewer } from "../auth";
import { closeSocketsOf } from "../realtime";

// Settings → Desk: Read access: the owner adds and removes the accounts that may
// look at the desk (server/auth.ts). Viewers can't reach these (OWNER_ONLY,
// and every request but a GET is refused them).

export const router = Router();

const view = () => ({ success: true, viewers: listViewers(), max: MAX_VIEWERS });

router.get("/api/viewers", (_req: Request, res: Response) => {
  res.json(view());
});

router.post("/api/viewers", validate({ body: viewerEmailBody }), (req: Request, res: Response) => {
  const added = addViewer(req.body.email);
  if (!added.ok) {
    res.status(400).json({ success: false, error: added.error, code: "NOT_ADDED" });
    return;
  }
  res.json(view());
});

router.post("/api/viewers/remove", validate({ body: viewerEmailBody }), (req: Request, res: Response) => {
  // Shut out at once: its next request is refused, and its live updates stop now.
  if (removeViewer(req.body.email)) closeSocketsOf(req.body.email);
  res.json(view());
});
