import { apiFetch } from "./apiClient";

// Autopilot and the kill switch ("Stop all"), kept on this device so a
// reload doesn't quietly undo them: a stopped desk stays stopped and
// autopilot stays as you left it. On a device that has never saved them,
// the server's copy (from your other devices) is adopted; until either is
// known, autopilot is off.

const KEY = "nexus_desk_controls_v1";

export interface DeskControls {
  autopilot: boolean;
  killSwitch: boolean;
}

export function loadDeskControls(): DeskControls | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && typeof saved.autopilot === "boolean" && typeof saved.killSwitch === "boolean") {
      return { autopilot: saved.autopilot, killSwitch: saved.killSwitch };
    }
  } catch {}
  return null;
}

export function saveDeskControls(controls: DeskControls): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(controls));
  } catch {}
}

/** The server's copy of this user's controls, or null if it has none (or can't be reached). */
export async function fetchServerDeskControls(): Promise<DeskControls | null> {
  try {
    const res = await apiFetch("/api/desk/state");
    if (!res.ok) return null;
    const desk = (await res.json())?.desk;
    if (desk && typeof desk.autopilot === "boolean" && typeof desk.killSwitch === "boolean") {
      return { autopilot: desk.autopilot, killSwitch: desk.killSwitch };
    }
  } catch {}
  return null;
}
