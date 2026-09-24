import { useEffect, useState } from "react";
import { apiFetch } from "../services/apiClient";

export interface ServerStatus {
  startedAt: number;
  uptimeSec: number;
  cloudRun: { service: string; revision: string } | null;
  storage: { dir: string; kept: boolean; note: string };
  scanner: { lastTickAt: number; lastCycleDoneAt: number; stalled: boolean };
  /** Angel One (Indian stocks); missing on an older server. */
  angelOne?: { configured: boolean; loggedIn: boolean; lastLoginAt: number; lastError: string | null; stocksKnown: number };
}

/** The server's host status, read while `active` (Settings open) and every minute. */
export function useServerStatus(active: boolean): ServerStatus | null {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const read = async () => {
      try {
        const res = await apiFetch("/api/server/status");
        if (!res.ok || cancelled) return;
        const body = await res.json();
        // An older server (or anything else answering) is ignored, not trusted.
        if (typeof body?.uptimeSec === "number" && typeof body?.storage?.kept === "boolean") setStatus(body as ServerStatus);
      } catch {}
    };
    void read();
    const timer = setInterval(read, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);
  return status;
}
