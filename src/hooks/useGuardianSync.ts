import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { apiFetch } from "../services/apiClient";
import type { DaemonCloseEvent } from "../services/daemonEvents";
import { markedPosition } from "../services/positionTick";
import { marketOf } from "../shared/marketLimits";
import type { Position } from "../types";

const LAST_POLL_KEY = "nexus_last_daemon_poll";
/** A trade opened here this recently may not be on the server yet (its order is on its way): kept while the guardian lacks it. */
export const PENDING_OPEN_MS = 2 * 60 * 1000;

/**
 * Whether a position's price comes from the guardian: coins stream to the
 * app live, so it shows its own; US and Indian stocks don't, so their price
 * (and the open P&L it makes) is the guardian's, which the server's scans
 * keep current.
 */
const priceFromGuardian = (symbol: string) => marketOf(symbol) !== "coins";

/** What a position shows: a poll that changes none of these leaves the list as it was. */
const SHOWN = [
  "stopLoss", "takeProfit", "currentPrice", "unrealizedPnl", "quantity", "highestPrice", "lowestPrice", "trailActive",
  "bankedQuantity", "bankedPrice",
] as const satisfies readonly (keyof Position)[];

/** The guardian's position as this app shows it: its stop, target and progress, at this app's price for a coin it holds. */
function asShown(g: Position, mine: Position | undefined): Position {
  const merged = { ...mine, ...g } as Position;
  const own = mine && !priceFromGuardian(g.symbol) && mine.currentPrice > 0 ? mine.currentPrice : 0;
  const price = own || g.currentPrice;
  return price > 0 ? markedPosition(merged, price) : merged;
}

/**
 * The open trades are the guardian's (it makes every exit, trails every
 * stop and banks every half): its list, at this app's prices for coins,
 * less ones this app is closing (`isClosed`: the close is on its way), plus
 * ones opened here moments ago it may not have yet. A trade the guardian
 * no longer holds has closed (its close comes with the same answer).
 * Returns `prev` itself when nothing shown changes.
 */
export function fromGuardian(prev: Position[], guardian: Position[], isClosed: (id: string) => boolean, now = Date.now()): Position[] {
  const listed = new Map(guardian.filter((g) => g?.id && !isClosed(g.id)).map((g) => [g.id, g]));
  const held = new Set(prev.map((p) => p.id));
  const added = [...listed.values()].filter((g) => !held.has(g.id)).map((g) => asShown(g, undefined));
  const kept: Position[] = [];
  for (const p of prev) {
    const g = listed.get(p.id);
    if (g) kept.push(asShown(g, p));
    else if (!isClosed(p.id) && now - Date.parse(p.openTime) < PENDING_OPEN_MS) kept.push(p);
  }
  const next = [...added, ...kept];
  const same = next.length === prev.length && next.every((p, i) => p.id === prev[i].id && SHOWN.every((k) => p[k] === prev[i][k]));
  return same ? prev : next;
}

/** A position the guardian just opened (the server's autopilot), added if this app doesn't show it yet. */
export function withGuardianPosition(prev: Position[], g: Position): Position[] {
  return prev.some((p) => p.id === g.id) ? prev : [asShown(g, undefined), ...prev];
}

// The open trades come from the server's 24/7 guardian, the only copy: on
// mount, on focus/visibility and every 10s the app takes its list
// (fromGuardian) and the closes it made since the last look. The app opens
// a trade with its order (/api/execute-trade) and closes one by asking
// (/api/daemon/close); it sends nothing else.
// Returns whether the guardian answered its last check (null until the first).
export function useGuardianSync(
  setActivePositions: Dispatch<SetStateAction<Position[]>>,
  applyServerClose: (ev: DaemonCloseEvent) => void,
  isClosedLocally: (id: string) => boolean = () => false
) {
  const [online, setOnline] = useState<boolean | null>(null);
  const isClosedRef = useRef(isClosedLocally);
  isClosedRef.current = isClosedLocally;

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

        for (const ev of (data.events ?? []) as DaemonCloseEvent[]) {
          applyServerClose(ev);
        }
        if (Array.isArray(data.activePositions)) {
          const guardian = data.activePositions as Position[];
          setActivePositions((prev) => fromGuardian(prev, guardian, (id) => isClosedRef.current(id)));
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
