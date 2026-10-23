import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../services/apiClient";

// Settings → Server → Recent log (server/routes/serverLog.ts): the server's
// latest lines, newest first, looked at again every so often while open.

export interface LogLine {
  at: number;
  level: "info" | "warn" | "error";
  text: string;
}

/** How many lines it shows, and how often it looks again while open. */
export const LOG_LINES = 200;
export const LOG_REFRESH_MS = 15_000;

export function useServerLog(active: boolean, problems: boolean) {
  /** undefined while loading; null when it couldn't be read (an older server, or none to reach). */
  const [lines, setLines] = useState<LogLine[] | null | undefined>(undefined);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/server-log?limit=${LOG_LINES}${problems ? "&problems=1" : ""}`);
      const data = res.ok ? await res.json() : null;
      setLines(data?.success && Array.isArray(data.lines) ? data.lines : null);
      setUpdatedAt(Date.now());
    } catch {
      setLines((l) => l ?? null);
    } finally {
      setLoading(false);
    }
  }, [problems]);

  useEffect(() => {
    if (!active) return;
    setLines(undefined);
    void load();
    const t = setInterval(() => void load(), LOG_REFRESH_MS);
    return () => clearInterval(t);
  }, [active, load]);

  return { lines, updatedAt, loading, refresh: load };
}
