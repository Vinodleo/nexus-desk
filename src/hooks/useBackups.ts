import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../services/apiClient";

// Settings → Server → Restore a backup (server/routes/backups.ts): the days
// there's a backup for, putting one back, and waiting while the server
// restarts to do it until it says how it went.

export interface BackupDay {
  day: string;
  bytes: number;
  /** When it was saved (ms). */
  at: number;
}

export interface RestoreResult {
  day: string;
  requestedAt: number;
  at: number;
  ok: boolean;
  files: number;
  error: string | null;
}

export interface BackupList {
  days: BackupDay[];
  restore: RestoreResult | null;
  pending: string | null;
}

/** How often it looks whether the server is back, while a restore restarts it, and how long before saying it's slow. */
export const RESTORE_CHECK_MS = 4000;
export const RESTORE_WAIT_MS = 3 * 60 * 1000;

export type RestorePhase = "idle" | "sending" | "restarting" | "slow" | "done";

export function useBackups(active: boolean) {
  /** undefined while loading; null when they couldn't be listed (note says why). */
  const [list, setList] = useState<BackupList | null | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);
  const [phase, setPhase] = useState<RestorePhase>("idle");
  const [waiting, setWaiting] = useState<{ requestedAt: number; since: number } | null>(null);

  const load = useCallback(async (): Promise<BackupList | null> => {
    try {
      const res = await apiFetch("/api/backups");
      const data = await res.json().catch(() => null);
      if (data?.success && Array.isArray(data.days)) {
        const next = { days: data.days, restore: data.restore ?? null, pending: data.pending ?? null };
        setList(next);
        return next;
      }
      setNote(data?.error || "Couldn't list the backups.");
    } catch {
      setNote("Couldn't reach the server.");
    }
    setList((l) => l ?? null);
    return null;
  }, []);

  useEffect(() => {
    if (active && phase === "idle") {
      setNote(null);
      void load();
    }
  }, [active, phase, load]);

  // While the server restarts: look until it answers with this restore's result.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      let data: any = null;
      try {
        const res = await apiFetch("/api/backups");
        data = res.ok ? await res.json() : null;
      } catch {}
      if (data?.restore?.requestedAt === waiting.requestedAt) {
        setList({ days: data.days ?? [], restore: data.restore, pending: data.pending ?? null });
        setWaiting(null);
        setPhase("done");
      } else if (Date.now() - waiting.since > RESTORE_WAIT_MS) {
        setPhase("slow");
      }
    }, RESTORE_CHECK_MS);
    return () => clearInterval(t);
  }, [waiting]);

  const restore = async (day: string) => {
    setPhase("sending");
    setNote(null);
    try {
      const res = await apiFetch("/api/backups/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ day }) });
      const data = await res.json().catch(() => null);
      if (data?.success && typeof data.requestedAt === "number") {
        setWaiting({ requestedAt: data.requestedAt, since: Date.now() });
        setPhase("restarting");
        return;
      }
      setNote(data?.error || "The server didn't take it.");
    } catch {
      setNote("Couldn't reach the server.");
    }
    setPhase("idle");
  };

  return { list, note, phase, restore };
}
