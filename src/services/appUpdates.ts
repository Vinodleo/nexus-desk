// Keeps the installed app (and open tabs) on the latest version.
//
// The service worker serves the app from its cache, and the browser only
// looks for a new one when the app is launched afresh. An installed app on
// a phone is usually resumed rather than relaunched, so it could stay on an
// old version for days. So: look for a new version whenever the app comes
// back on screen (at most once a minute) and every 30 minutes. With
// registerType "autoUpdate" a new version takes over and the page reloads.

/** When this copy of the app was built (set by vite.config.ts). */
export const APP_BUILT_AT: string = typeof __APP_BUILT_AT__ === "string" ? __APP_BUILT_AT__ : "";

export const UPDATE_EVERY_MS = 30 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000;

let lastCheck = 0;

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return await navigator.serviceWorker?.getRegistration();
  } catch {
    return undefined;
  }
}

export type UpdateCheck = "updating" | "latest" | "unavailable";

/**
 * Asks the server for a newer version. "updating" means one was found and
 * is installing (the app reloads when it's ready).
 */
export async function checkForUpdate(force = false): Promise<UpdateCheck> {
  const now = Date.now();
  if (!force && now - lastCheck < MIN_GAP_MS) return "latest";
  lastCheck = now;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "unavailable";
  const reg = await registration();
  if (!reg) return "unavailable";
  try {
    await reg.update();
  } catch {
    return "unavailable";
  }
  return reg.installing || reg.waiting ? "updating" : "latest";
}

/** Keeps looking for new versions: when the app comes back on screen, and every 30 minutes. */
export function watchForUpdates(): void {
  setInterval(() => void checkForUpdate(), UPDATE_EVERY_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForUpdate();
  });
}

/** "25 Sep, 2:05 pm" */
export function builtAtText(iso = APP_BUILT_AT): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "development build";
  const d = new Date(t);
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
