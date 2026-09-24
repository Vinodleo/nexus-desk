import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { apiFetch } from "../services/apiClient";
import type { DaemonCloseEvent } from "../services/daemonEvents";
import type { Position } from "../types";

const LAST_POLL_KEY = "nexus_last_daemon_poll";

// Keeps the server's 24/7 position guardian in step with the browser book:
// pushes every change to the open positions, and pulls closes the guardian
// made while this tab was asleep (on mount, on focus/visibility, every 10s).
// Returns whether the guardian answered its last check (null until the first).
export function useGuardianSync(
  activePositions: Position[],
  setActivePositions: Dispatch<SetStateAction<Position[]>>,
  applyServerClose: (ev: DaemonCloseEvent) => void
) {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    const sync = async () => {
      try {
        const res = await apiFetch("/api/daemon/sync-positions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positions: activePositions }),
        });
        if (res.ok) {
          const data = await res.json();
          // Positions the guardian already closed must not come back.
          if (data.rejectedResurrections?.length > 0) {
            const rejected = new Set<string>(data.rejectedResurrections);
            setActivePositions((prev) => prev.filter((p) => !rejected.has(p.id)));
          }
        } else if (res.status === 400) {
          console.warn("[DaemonSync] Server rejected the position sync:", await res.json());
        }
      } catch (err) {
        console.warn("[DaemonSync] Failed to sync positions to server:", err);
      }
    };
    sync();
  }, [activePositions, setActivePositions]);

  useEffect(() => {
    let lastCheckedTime = 0;
    try {
      lastCheckedTime = Number(localStorage.getItem(LAST_POLL_KEY)) || 0;
    } catch {}

    const reconcile = async () => {
      try {
        const res = await apiFetch(`/api/daemon/closed-events?since=${lastCheckedTime}`);
        if (!res.ok) {
          setOnline(false);
          return;
        }
        const data = await res.json();
        setOnline(true);
        lastCheckedTime = Date.now();
        try {
          localStorage.setItem(LAST_POLL_KEY, String(lastCheckedTime));
        } catch {}

        // Empty local book but the guardian restored positions after a crash:
        // show them.
        if (data.activePositions?.length > 0) {
          setActivePositions((prev) => (prev.length === 0 ? data.activePositions : prev));
        }
        for (const ev of (data.events ?? []) as DaemonCloseEvent[]) {
          applyServerClose(ev);
        }
      } catch (err) {
        setOnline(false);
        console.warn("[DaemonSync] Error reconciling daemon events:", err);
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };

    reconcile();
    const interval = setInterval(reconcile, 10000);
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [setActivePositions, applyServerClose]);

  return online;
}
