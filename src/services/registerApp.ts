import { registerSW } from "virtual:pwa-register";
import { watchForUpdates } from "./appUpdates";

// Registers the service worker (the app works offline and installs) and
// keeps looking for new versions. Imported only by main.tsx: the virtual
// module exists only in the Vite build.
export function startAppUpdates(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    registerSW({ immediate: true });
  } catch (err) {
    console.warn("[Updates] Couldn't register the service worker:", err);
    return;
  }
  watchForUpdates();
}
