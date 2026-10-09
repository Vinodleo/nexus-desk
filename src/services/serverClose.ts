import { apiFetch } from "./apiClient";
import type { DaemonCloseEvent } from "./daemonEvents";

/**
 * Asks the server's guardian to close a trade (by hand): it holds the open
 * trades, so it closes and records it (its closed trades hold every trade,
 * and a live trade's exchange exit goes out from there). Its record of the
 * close (`already` if it was closed before: by the guardian itself, or on
 * another device),
 * "not-held" when it isn't holding the trade, or null when it can't be
 * reached (the trade stays open).
 */
export async function reportCloseToServer(
  positionId: string,
  price: number,
  reason: DaemonCloseEvent["exitReason"]
): Promise<(DaemonCloseEvent & { already?: boolean }) | "not-held" | null> {
  if (!(price > 0)) return null;
  try {
    const res = await apiFetch("/api/daemon/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionId, price, reason }),
    });
    if (res.status === 404) return "not-held";
    if (!res.ok) return null;
    const data = await res.json();
    return data?.success && data.event ? { ...(data.event as DaemonCloseEvent), ...(data.already ? { already: true } : {}) } : null;
  } catch {
    return null;
  }
}
