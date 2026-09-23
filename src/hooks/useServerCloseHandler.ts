import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { daemonEventToTrade, type DaemonCloseEvent } from "../services/daemonEvents";
import type { HistoricalTrade, Position } from "../types";

interface BookSetters {
  setActivePositions: Dispatch<SetStateAction<Position[]>>;
  setClosedTrades: Dispatch<SetStateAction<HistoricalTrade[]>>;
  setEquity: Dispatch<SetStateAction<number>>;
  setCash: Dispatch<SetStateAction<number>>;
  setDailyRealizedPnl: Dispatch<SetStateAction<number>>;
}

// Applies a close made by the server guardian to the browser book.
//
// The same close can arrive over the WebSocket and again from the catch-up
// poll, and the browser may be closing the same position itself. P&L is
// credited only by whichever path claims the position first (via the shared
// closingPositionIds set, which the browser's own close path also uses), or
// not at all if the trade is already recorded. Returns true if this call
// applied the close.
export function useServerCloseHandler(
  closingPositionIds: MutableRefObject<Set<string>>,
  closedTradesRef: MutableRefObject<HistoricalTrade[]>,
  { setActivePositions, setClosedTrades, setEquity, setCash, setDailyRealizedPnl }: BookSetters
) {
  return useCallback(
    (ev: DaemonCloseEvent): boolean => {
      if (!ev?.positionId) return false;
      setActivePositions((prev) => prev.filter((p) => p.id !== ev.positionId));

      const alreadyRecorded = closedTradesRef.current.some((t) => t.id === ev.id || t.positionId === ev.positionId);
      if (closingPositionIds.current.has(ev.positionId) || alreadyRecorded) return false;
      closingPositionIds.current.add(ev.positionId);

      setClosedTrades((prev) =>
        prev.some((t) => t.id === ev.id || t.positionId === ev.positionId) ? prev : [daemonEventToTrade(ev), ...prev]
      );
      setEquity((prev) => Number((prev + ev.realizedPnl).toFixed(2)));
      setCash((prev) => Number((prev + ev.moneyPlaced + ev.realizedPnl).toFixed(2)));
      setDailyRealizedPnl((prev) => Number((prev + ev.realizedPnl).toFixed(2)));
      return true;
    },
    [closingPositionIds, closedTradesRef, setActivePositions, setClosedTrades, setEquity, setCash, setDailyRealizedPnl]
  );
}
