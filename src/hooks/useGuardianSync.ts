import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { mergeGuardState, type GuardFields } from "../shared/trailingStop";
import { apiFetch } from "../services/apiClient";
import type { DaemonCloseEvent } from "../services/daemonEvents";
import type { Position } from "../types";

const LAST_POLL_KEY = "nexus_last_daemon_poll";
const SYNC_THROTTLE_MS = 1500;

const idsOf = (positions: Position[]) => positions.map((p) => p.id).sort().join(",");

/**
 * The browser's positions with the guardian's progress folded in (the more
 * protective stop, the further target, wider extremes, trailing, banked
 * half). Returns `prev` itself when nothing changes.
 */
export function adoptGuardianState(prev: Position[], guardian: (GuardFields & { id: string })[]): Position[] {
  const byId = new Map(guardian.map((g) => [g.id, g]));
  let changed = false;
  const next = prev.map((p) => {
    const g = byId.get(p.id);
    if (!g) return p;
    const merged = mergeGuardState(p.direction, p.entryPrice, g, p);
    const differs = (Object.keys(merged) as (keyof GuardFields)[]).some((k) => merged[k] !== undefined && merged[k] !== p[k]);
    if (!differs) return p;
    changed = true;
    return { ...p, ...Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) };
  });
  return changed ? next : prev;
}

/**
 * The browser's positions plus any the server's autopilot opened that this
 * book doesn't have yet (`isClosed`: ones this app already closed, whose
 * removal the guardian may not have heard of yet). Returns `prev` itself
 * when there's nothing to add.
 */
export function adoptServerOpened(
  prev: Position[],
  guardian: (Position & { openedByServer?: boolean; clientSeen?: boolean })[],
  isClosed: (id: string) => boolean
): Position[] {
  const have = new Set(prev.map((p) => p.id));
  const added = guardian.filter((g) => g.openedByServer && !g.clientSeen && !have.has(g.id) && !isClosed(g.id));
  return added.length > 0 ? [...added, ...prev] : prev;
}

// Keeps the server's 24/7 position guardian in step with the browser book:
// pushes every change to the open positions, and pulls closes the guardian
// made while this tab was asleep (on mount, on focus/visibility, every 10s).
// Returns whether the guardian answered its last check (null until the first).
export function useGuardianSync(
  activePositions: Position[],
  setActivePositions: Dispatch<SetStateAction<Position[]>>,
  applyServerClose: (ev: DaemonCloseEvent) => void,
  isClosedLocally: (id: string) => boolean = () => false
) {
  const [online, setOnline] = useState<boolean | null>(null);
  const isClosedRef = useRef(isClosedLocally);
  isClosedRef.current = isClosedLocally;

  // Pushes the book to the guardian: right away when a position opens or
  // closes, otherwise at most every SYNC_THROTTLE_MS (prices tick several
  // times a second; the guardian trails stops itself between syncs).
  const latest = useRef(activePositions);
  latest.current = activePositions;
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIds = useRef<string | null>(null);

  useEffect(() => {
    const sync = async () => {
      pending.current = null;
      const positions = latest.current;
      lastIds.current = idsOf(positions);
      try {
        const res = await apiFetch("/api/daemon/sync-positions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positions }),
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
    if (idsOf(activePositions) !== lastIds.current) {
      if (pending.current) clearTimeout(pending.current);
      void sync();
    } else if (!pending.current) {
      pending.current = setTimeout(() => void sync(), SYNC_THROTTLE_MS);
    }
  }, [activePositions, setActivePositions]);

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    []
  );

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
        // show them. Otherwise take up whatever the guardian moved further
        // while this tab slept (a tighter stop, a runner's extended target)
        // and positions the server's autopilot opened meanwhile.
        if (data.activePositions?.length > 0) {
          setActivePositions((prev) =>
            prev.length === 0
              ? data.activePositions.filter((p: Position) => !isClosedRef.current(p.id))
              : adoptServerOpened(adoptGuardianState(prev, data.activePositions), data.activePositions, isClosedRef.current)
          );
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
