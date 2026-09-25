import { Router, type Request, type Response } from "express";
import type { AuthedRequest } from "../auth";
import { validate, pushSubscribeBody, pushUnsubscribeBody } from "../validation";
import { addSubscription, hasSubscription, pushPublicKey, removeSubscription } from "../push";

// Trade notifications: the phone subscribes (from Settings) and the server
// pushes to it when a trade opens.

export const router = Router();

const uidOf = (req: Request) => (req as AuthedRequest).user!.uid;

router.get("/api/push/key", (_req: Request, res: Response) => {
  res.json({ success: true, publicKey: pushPublicKey() });
});

router.post("/api/push/subscribe", validate({ body: pushSubscribeBody }), (req: Request, res: Response) => {
  addSubscription(uidOf(req), req.body.subscription);
  res.json({ success: true });
});

router.post("/api/push/unsubscribe", validate({ body: pushUnsubscribeBody }), (req: Request, res: Response) => {
  removeSubscription(uidOf(req), req.body.endpoint);
  res.json({ success: true });
});

// Whether this device's subscription is still known to the server.
router.post("/api/push/status", validate({ body: pushUnsubscribeBody }), (req: Request, res: Response) => {
  res.json({ success: true, subscribed: hasSubscription(uidOf(req), req.body.endpoint) });
});
