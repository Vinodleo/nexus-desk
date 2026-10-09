import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { mergeGuardState, type GuardFields } from "../shared/trailingStop";
import { apiFetch } from "../services/apiClient";
import type { DaemonCloseEvent } from "../services/daemonEvents";
import { markedPosition } from "../services/positionTick";
import { marketOf } from "../shared/marketLimits";
import type { Position } from "../types";

const LAST_POLL_KEY = "nexus_last_daemon_poll";
const SYNC_THROTTLE_MS = 1500;
/** Positions that left this book (closed, or dropped), with when: told to the guardian for a week. */
const GONE_KEY = "nexus_gone_positions";
const GONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many told at once (the newest). */
const GONE_MAX = 300;

function loadGone(): Map<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(GONE_KEY) ?? "[]");
    if (Array.isArray(raw)) return new Map(raw.filter((e) => Array.isArray(e) && typeof e[0] === "string" && Number.isFinite(e[1])));
  } catch {}
  return new Map();
}

function saveGone(gone: Map<string, number>): void {
  try {
    localStorage.setItem(GONE_KEY, JSON.stringify([...gone]));
  } catch {}
}

/**
 * Notes the positions that left the book since `shown` (closed here, or
 * dropped) and forgets ones back in it or older than a week. Returns whether
 * the list changed.
 */
export function noteGone(gone: Map<string, number>, shown: Set<string>, now: Set<string>, at: number): boolean {
  let changed = false;
  for (const id of shown) {
    if (!now.has(id) && !gone.has(id)) {
      gone.set(id, at);
      changed = true;
    }
  }
  for (const [id, when] of gone) {
    if (now.has(id) || when < at - GONE_KEEP_MS) {
      gone.delete(id);
      changed = true;
    }
  }
  while (gone.size > GONE_MAX) {
    gone.delete(gone.keys().next().value!);
    changed = true;
  }
  return changed;
}

const idsOf = (positions: Position[]) => positions.map((p) => p.id).sort().join(",");

/**
 * Whether the app has prices of its own for a position: coins stream to it
 * live. US and Indian stocks don't, so their price (and the open P&L it
 * makes) comes from the guardian, which the server's scans keep current.
 */
const priceFromGuardian = (symbol: string) => marketOf(symbol) !== "coins";

/**
 * The browser's positions with the guardian's progress folded in (the more
 * protective stop, the further target, wider extremes, trailing, banked
 * half), and its price for positions the app has no prices for. Returns
 * `prev` itself when nothing changes.
 */
export function adoptGuardianState(prev: Position[], guardian: (GuardFields & { id: string; currentPrice?: number })[]): Position[] {
  const byId = new Map(guardian.map((g) => [g.id, g]));
  let changed = false;
  const next = prev.map((p) => {
    const g = byId.get(p.id);
    if (!g) return p;
    const merged = mergeGuardState(p.direction, p.entryPrice, g, p);
    const differs = (Object.keys(merged) as (keyof GuardFields)[]).some((k) => merged[k] !== undefined && merged[k] !== p[k]);
    const guarded = differs ? { ...p, ...Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) } : p;
    const price = priceFromGuardian(p.symbol) && g.currentPrice && g.currentPrice > 0 ? g.currentPrice : null;
    // At the guardian's price, with the open P&L it makes: also when the price is the one already shown but its P&L isn't
    // (a position kept from before the app worked it out, while the market is closed and the price doesn't move).
    const marked = price === null ? guarded : markedPosition(guarded, price);
    const repriced = marked.currentPrice !== p.currentPrice || Math.abs(marked.unrealizedPnl - p.unrealizedPnl) > 0.005;
    if (!differs && !repriced) return p;
    changed = true;
    return marked;
  });
  return changed ? next : prev;
}

/** A position as the guardian sent it, its open P&L worked out from its price (the guardian doesn't keep one). */
const asSent = (g: Position): Position => (g.currentPrice > 0 ? markedPosition(g, g.currentPrice) : g);

/**
 * The browser's positions plus any the guardian holds that this book doesn't
 * have yet: opened by the server's autopilot, or on another device
 * (`isClosed`: ones this app already closed or dropped, whose removal the
 * guardian may not have heard of yet). Not a server-opened one the app
 * hasn't seen in a coin the book already holds: that's the same signal
 * opened twice, and the server drops its copy on the next sync. Returns
 * `prev` itself when there's nothing to add.
 */
export function adoptGuardianPositions(
  prev: Position[],
  guardian: (Position & { openedByServer?: boolean; clientSeen?: boolean })[],
  isClosed: (id: string) => boolean
): Position[] {
  const have = new Set(prev.map((p) => p.id));
  const held = new Set(prev.map((p) => p.symbol));
  const added: Position[] = [];
  for (const g of guardian) {
    if (have.has(g.id) || isClosed(g.id)) continue;
    if (g.openedByServer && !g.clientSeen && held.has(g.symbol)) continue;
    added.push(asSent(g));
    held.add(g.symbol);
  }
  return added.length > 0 ? [...added, ...prev] : prev;
}

// Keeps the server's 24/7 position guardian in step with the browser book:
// pushes every change to the open positions, and pulls closes the guardian
// made while this tab was asleep (on mount, on focus/visibility, every 10s).
// Each push tells which positions left this book lately (closed or dropped):
// only those leave the guardian, so another device's older book can't drop a
// trade it hasn't heard of, and a catch-up poll takes up any trade the
// guardian holds that this book lacks. Nothing is pushed until the guardian
// has answered once, so an empty book (a new install, cleared storage) takes
// up the guardian's positions first.
// Returns whether the guardian answered its last check (null until the first).
export function useGuardianSync(
  activePositions: Position[],
  setActivePositions: Dispatch<SetStateAction<Position[]>>,
  applyServerClose: (ev: DaemonCloseEvent) => void,
  isClosedLocally: (id: string) => boolean = () => false
) {
  const [online, setOnline] = useState<boolean | null>(null);
  // The guardian has answered a catch-up poll, so the book holds its positions too.
  const [heard, setHeard] = useState(false);
  const isClosedRef = useRef(isClosedLocally);
  isClosedRef.current = isClosedLocally;
  // Positions that left this book lately, and the ones it showed last.
  const gone = useRef<Map<string, number> | null>(null);
  gone.current ??= loadGone();
  const shown = useRef<Set<string> | null>(null);
  shown.current ??= new Set(activePositions.map((p) => p.id));

  // Pushes the book to the guardian: right away when a position opens or
  // closes, otherwise at most every SYNC_THROTTLE_MS (prices tick several
  // times a second; the guardian trails stops itself between syncs).
  const latest = useRef(activePositions);
  latest.current = activePositions;
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIds = useRef<string | null>(null);

  useEffect(() => {
    const ids = new Set(activePositions.map((p) => p.id));
    if (noteGone(gone.current!, shown.current!, ids, Date.now())) saveGone(gone.current!);
    shown.current = ids;
    if (!heard) return;
    const sync = async () => {
      pending.current = null;
      const positions = latest.current;
      lastIds.current = idsOf(positions);
      const held = new Set(positions.map((p) => p.id));
      const closedIds = [...gone.current!.keys()].filter((id) => !held.has(id));
      try {
        const res = await apiFetch("/api/daemon/sync-positions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positions, closedIds }),
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
  }, [activePositions, setActivePositions, heard]);

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

        // Take up whatever the guardian moved further while this tab slept
        // (a tighter stop, a runner's extended target) and the positions it
        // holds that this book lacks: opened by the server's autopilot or on
        // another device, or all of them into an empty book.
        if (data.activePositions?.length > 0) {
          const isClosed = (id: string) => gone.current!.has(id) || isClosedRef.current(id);
          setActivePositions((prev) => adoptGuardianPositions(adoptGuardianState(prev, data.activePositions), data.activePositions, isClosed));
        }
        for (const ev of (data.events ?? []) as DaemonCloseEvent[]) {
          applyServerClose(ev);
        }
        setHeard(true);
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
