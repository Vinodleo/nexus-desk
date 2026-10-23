import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../services/apiClient";

// Settings → Desk: Read access (server/routes/viewers.ts): the accounts that may
// look at the desk, whether each has signed in, adding one and removing one.

export interface ViewerRow {
  email: string;
  signedIn: boolean;
}

export function useViewers(active: boolean) {
  /** undefined while loading; null when the server has no list (an older one). */
  const [viewers, setViewers] = useState<ViewerRow[] | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/viewers");
      const data = res.ok ? await res.json() : null;
      setViewers(data?.success && Array.isArray(data.viewers) ? data.viewers : null);
    } catch {}
  }, []);

  useEffect(() => {
    if (active) void load();
    else setNote(null);
  }, [active, load]);

  const post = async (path: string, email: string): Promise<boolean> => {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const data = await res.json().catch(() => null);
      if (data?.success && Array.isArray(data.viewers)) {
        setViewers(data.viewers);
        return true;
      }
      setNote(data?.code === "VALIDATION_ERROR" ? "That isn't an email address." : data?.error || "The server didn't take it.");
      return false;
    } catch {
      setNote("Couldn't reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = (email: string) => post("/api/viewers", email.trim());
  const remove = (email: string) => post("/api/viewers/remove", email);

  return { viewers, busy, note, add, remove };
}
