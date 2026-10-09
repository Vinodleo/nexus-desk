import { apiFetch } from "./apiClient";
import type { DaemonCloseEvent } from "./daemonEvents";

/**
 * Tells the server's guardian about a close the app made (by hand, or on its
 * own prices), so the server's closed trades hold every trade, and a live
 * trade's exchange exit goes out from there. Its record of the close, or null
 * when the server can't be reached or wasn't holding the position.
 */
export async function reportCloseToServer(
  positionId: string,
  price: number,
  reason: DaemonCloseEvent["exitReason"]
): Promise<DaemonCloseEvent | null> {
  if (!(price > 0)) return null;
  try {
    const res = await apiFetch("/api/daemon/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionId, price, reason }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.success && data.event ? (data.event as DaemonCloseEvent) : null;
  } catch {
    return null;
  }
}
