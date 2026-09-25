import fs from "fs";
import path from "path";
import webpush, { type PushSubscription } from "web-push";

// Pop-up notifications on your phone (Web Push), even with the app closed
// and the phone locked: the server sends them when a trade opens. The phone
// subscribes once from Settings; its subscription is kept here per user.
//
// The server's own key pair (VAPID) identifies it to the phone's push
// service. It's made on first use and kept on disk, or can be set with
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.

const DATA_DIR = process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const KEYS_FILE = path.join(DATA_DIR, "vapid_keys.json");
const SUBS_FILE = path.join(DATA_DIR, "push_subscriptions.json");
/** Each user keeps at most this many devices subscribed. */
const MAX_DEVICES = 10;

let keys: { publicKey: string; privateKey: string } | null = null;
let subs: Record<string, PushSubscription[]> | null = null;

function writeJson(file: string, data: unknown): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), "utf8");
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn("[Push] Couldn't save:", err);
  }
}

function vapidKeys(): { publicKey: string; privateKey: string } {
  if (keys) return keys;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    keys = { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
  } else {
    try {
      const saved = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")) : null;
      if (saved?.publicKey && saved?.privateKey) keys = saved;
    } catch {}
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      writeJson(KEYS_FILE, keys);
    }
  }
  const appUrl = process.env.APP_URL || "";
  const subject = /^https:\/\//.test(appUrl) ? appUrl : "mailto:nexus-desk@localhost";
  webpush.setVapidDetails(subject, keys!.publicKey, keys!.privateKey);
  return keys!;
}

function subscriptions(): Record<string, PushSubscription[]> {
  if (subs) return subs;
  try {
    subs = fs.existsSync(SUBS_FILE) ? JSON.parse(fs.readFileSync(SUBS_FILE, "utf8")) : {};
  } catch {
    subs = {};
  }
  return subs!;
}

/** The key a phone subscribes with. */
export function pushPublicKey(): string {
  return vapidKeys().publicKey;
}

export function addSubscription(uid: string, sub: PushSubscription): void {
  const all = subscriptions();
  const mine = (all[uid] ?? []).filter((s) => s.endpoint !== sub.endpoint);
  all[uid] = [...mine, sub].slice(-MAX_DEVICES);
  writeJson(SUBS_FILE, all);
}

export function removeSubscription(uid: string, endpoint: string): void {
  const all = subscriptions();
  all[uid] = (all[uid] ?? []).filter((s) => s.endpoint !== endpoint);
  writeJson(SUBS_FILE, all);
}

export function hasSubscription(uid: string, endpoint: string): boolean {
  return (subscriptions()[uid] ?? []).some((s) => s.endpoint === endpoint);
}

export interface PushMessage {
  title: string;
  body: string;
  /** Replaces an earlier notification with the same tag instead of stacking. */
  tag?: string;
  /** Opened when the notification is tapped. */
  url?: string;
}

/** Sends to every device the user subscribed; devices that have gone away are forgotten. Returns how many it reached. */
export async function notifyUser(uid: string | undefined, message: PushMessage): Promise<number> {
  if (!uid) return 0;
  const mine = subscriptions()[uid] ?? [];
  if (mine.length === 0) return 0;
  vapidKeys();
  let sent = 0;
  const gone: string[] = [];
  await Promise.all(
    mine.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(message), { TTL: 60 * 60 });
        sent++;
      } catch (err: any) {
        // 404/410: the subscription was cancelled (app uninstalled, permission removed).
        if (err?.statusCode === 404 || err?.statusCode === 410) gone.push(sub.endpoint);
        else console.warn(`[Push] Couldn't notify ${uid}:`, err?.statusCode ?? "", err?.message ?? err);
      }
    })
  );
  for (const endpoint of gone) removeSubscription(uid, endpoint);
  return sent;
}

export { tradeOpenedMessage, tradeClosedMessage } from "../src/shared/tradeMessages";

/** Test hook. */
export function _resetPush(): void {
  keys = null;
  subs = null;
}
