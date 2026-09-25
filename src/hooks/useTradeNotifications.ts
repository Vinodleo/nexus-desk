import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../services/apiClient";

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

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export function useTradeNotifications() {
  const [state, setState] = useState<NotifyState>(() => (supported() ? "working" : "unsupported"));
  const [error, setError] = useState("");

  // Where things stand on this device.
  useEffect(() => {
    if (!supported()) return;
    let cancelled = false;
    (async () => {
      if (Notification.permission === "denied") return !cancelled && setState("blocked");
      const sub = await currentSubscription().catch(() => null);
      if (!sub) return !cancelled && setState("off");
      // Make sure the server still has it (it forgets devices that went away).
      const res = await apiFetch("/api/push/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => null);
      const known = res?.ok ? (await res.json()).subscribed : true;
      if (!known) {
        await apiFetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        }).catch(() => null);
      }
      if (!cancelled) setState("on");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    if (!supported()) return;
    setError("");
    setState("working");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const keyRes = await apiFetch("/api/push/key");
      if (!keyRes.ok) throw new Error("The server didn't give its notification key.");
      const { publicKey } = await keyRes.json();
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
      const res = await apiFetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error("The server didn't accept this device.");
      setState("on");
    } catch (err: any) {
      setError(err?.message || "Couldn't turn notifications on.");
      setState("off");
    }
  }, []);

  const disable = useCallback(async () => {
    if (!supported()) return;
    setState("working");
    try {
      const sub = await currentSubscription();
      if (sub) {
        await apiFetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => null);
        await sub.unsubscribe();
      }
    } finally {
      setState("off");
    }
  }, []);

  return { state, error, enable, disable };
}
