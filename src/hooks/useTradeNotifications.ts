import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../services/apiClient";
import type { TradeMessage } from "../shared/tradeMessages";

// Pop-up notifications when a trade opens, even with the app closed: this
// device subscribes to the server's pushes (Web Push) through the app's
// service worker. On iPhone it works only for the app added to the home
// screen.

export type NotifyState = "unsupported" | "blocked" | "off" | "on" | "working";

function supported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The server's key, from base64url to the bytes the browser wants. */
function keyBytes(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** How long to wait for the app's service worker before saying why it isn't there. */
export const WORKER_WAIT_MS = 8000;
/** How long to wait for the server before giving up on a check. */
const SERVER_WAIT_MS = 10000;

const timeout = <T,>(ms: number) => new Promise<T | null>((resolve) => setTimeout(() => resolve(null), ms));

/**
 * The app's service worker, which receives the pushes. `ready` never settles
 * while there's no active worker (not registered yet, still installing, or
 * its install failed), so this waits a limited time, then says why. With
 * `register`, a missing worker is registered first (the same one the app
 * registers at start-up).
 */
export async function pushWorker(opts: { register?: boolean; waitMs?: number } = {}): Promise<ServiceWorkerRegistration> {
  const sw = navigator.serviceWorker;
  if (opts.register && !(await sw.getRegistration().catch(() => undefined))) {
    await sw.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }
  const reg = await Promise.race([sw.ready, timeout<ServiceWorkerRegistration>(opts.waitMs ?? WORKER_WAIT_MS)]);
  if (reg) return reg;
  const found = await sw.getRegistration().catch(() => undefined);
  throw new Error(
    !found
      ? "The app's background worker isn't installed on this phone. Tap the switch to try again, or close the app fully and reopen it."
      : found.installing || found.waiting
      ? "The app is still installing its offline files. Try again in a minute."
      : "The app's background worker isn't running. Close the app fully and reopen it, then try again."
  );
}

/** The server call, or null if it doesn't answer in time. */
async function serverCall(path: string, body?: unknown): Promise<Response | null> {
  const call = apiFetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  return Promise.race([call, timeout<Response>(SERVER_WAIT_MS)]);
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await pushWorker();
  return reg.pushManager.getSubscription();
}

/**
 * Shows a trade pop-up from this app (for a trade it closed itself; the
 * server sends its own). Needs notifications allowed; does nothing otherwise.
 */
export async function showLocalTradePopup(msg: TradeMessage): Promise<void> {
  if (!supported() || Notification.permission !== "granted") return;
  try {
    const reg = await pushWorker();
    await reg.showNotification(msg.title, {
      body: msg.body,
      tag: msg.tag,
      icon: "/pwa-192x192.png",
      badge: "/pwa-192x192.png",
      data: { url: msg.url },
    });
  } catch {}
}

export function useTradeNotifications() {
  const [state, setState] = useState<NotifyState>(() => (supported() ? "working" : "unsupported"));
  const [error, setError] = useState("");
  /** Set once the switch is used: the start-up check then no longer sets the state. */
  const acted = useRef(false);

  // Where things stand on this device. Never left on "Checking…": a worker
  // or server that doesn't answer in time leaves the switch off, with why.
  useEffect(() => {
    if (!supported()) return;
    let cancelled = false;
    const stale = () => cancelled || acted.current;
    (async () => {
      if (Notification.permission === "denied") return !stale() && setState("blocked");
      let sub: PushSubscription | null;
      try {
        sub = await currentSubscription();
      } catch (err: any) {
        if (!stale()) {
          setError(err?.message || "");
          setState("off");
        }
        return;
      }
      if (!sub) return !stale() && setState("off");
      // Make sure the server still has it (it forgets devices that went away).
      const res = await serverCall("/api/push/status", { endpoint: sub.endpoint });
      const known = res?.ok ? (await res.json().catch(() => ({ subscribed: true }))).subscribed : true;
      if (!known) await serverCall("/api/push/subscribe", { subscription: sub.toJSON() });
      if (!stale()) setState("on");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    if (!supported()) return;
    acted.current = true;
    setError("");
    setState("working");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const keyRes = await serverCall("/api/push/key");
      if (!keyRes?.ok) throw new Error("The server didn't give its notification key. Try again.");
      const { publicKey } = await keyRes.json();
      // Registers the worker if it's missing, and waits a little longer for it.
      const reg = await pushWorker({ register: true, waitMs: 15000 });
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
      const res = await serverCall("/api/push/subscribe", { subscription: sub.toJSON() });
      if (!res?.ok) throw new Error("The server didn't accept this phone. Try again.");
      setState("on");
    } catch (err: any) {
      setError(err?.message || "Couldn't turn notifications on.");
      setState("off");
    }
  }, []);

  const disable = useCallback(async () => {
    if (!supported()) return;
    acted.current = true;
    setState("working");
    setError("");
    try {
      const sub = await currentSubscription();
      if (sub) {
        await serverCall("/api/push/unsubscribe", { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
    } catch {
      // Nothing subscribed that can be reached: it's off either way.
    } finally {
      setState("off");
    }
  }, []);

  return { state, error, enable, disable };
}
