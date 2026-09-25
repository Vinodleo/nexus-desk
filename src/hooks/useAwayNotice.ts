import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { AWAY_SETTLE_MS, QUIET_AWAY_MS, awayTier, summarizeAway, type AwaySummary } from "../services/awaySummary";
import type { HistoricalTrade, Position } from "../types";

export type AwayNoticeState =
  | { id: number; phase: "syncing"; awayMs: number }
  | { id: number; phase: "pill"; summary: AwaySummary }
  | { id: number; phase: "card"; summary: AwaySummary };

// On unlocking: show "Syncing…" straight away for a long lock, wait for the
// server's catch-up to land, then sum up what happened while away and pick
// how loud to be (see services/awaySummary).
export function useAwayNotice(
  positionsRef: MutableRefObject<Position[]>,
  closedTradesRef: MutableRefObject<HistoricalTrade[]>
) {
  const [notice, setNotice] = useState<AwayNoticeState | null>(null);
  /** Bumped to replay the header badge's glow. */
  const [glowKey, setGlowKey] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextId = useRef(1);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onUnlock = useCallback(
    (elapsedMs: number) => {
      const id = nextId.current++;
      const since = Date.now() - elapsedMs;
      if (timer.current) clearTimeout(timer.current);
      // A card still open from an earlier unlock stays until it's dismissed.
      setNotice((prev) => (prev?.phase === "card" ? prev : elapsedMs >= QUIET_AWAY_MS ? { id, phase: "syncing", awayMs: elapsedMs } : null));
      timer.current = setTimeout(() => {
        timer.current = null;
        const summary = summarizeAway(since, Date.now(), positionsRef.current, closedTradesRef.current);
        const tier = awayTier(summary);
        if (tier === "card") {
          try { navigator.vibrate?.(30); } catch {}
          setNotice({ id, phase: "card", summary });
          return;
        }
        setNotice((prev) => (prev?.phase === "card" ? prev : tier === "pill" ? { id, phase: "pill", summary } : null));
        if (tier === "glow") setGlowKey((k) => k + 1);
      }, AWAY_SETTLE_MS);
    },
    [positionsRef, closedTradesRef]
  );

  const dismiss = useCallback(() => setNotice(null), []);

  return { notice, glowKey, onUnlock, dismiss };
}
