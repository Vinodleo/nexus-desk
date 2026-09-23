import type { HistoricalTrade } from "../types";

// A position the server guardian closed, as sent over the WebSocket
// (DAEMON_POSITION_CLOSED) and by /api/daemon/closed-events.
export interface DaemonCloseEvent {
  id: string;
  positionId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  moneyPlaced: number;
  grossPnl: number;
  feesPaid: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  isWin: boolean;
  exitReason: HistoricalTrade["exitReason"];
  closedAt: string;
  openedAt: string;
  holdingDurationMinutes?: number;
  setupName?: string;
}

export function daemonEventToTrade(ev: DaemonCloseEvent): HistoricalTrade {
  return {
    id: ev.id,
    positionId: ev.positionId,
    symbol: ev.symbol,
    direction: ev.direction,
    setupName: ev.setupName || "Statistical Trailing System",
    entryPrice: ev.entryPrice,
    exitPrice: ev.exitPrice,
    quantity: ev.quantity,
    moneyPlaced: ev.moneyPlaced,
    grossPnl: ev.grossPnl,
    feesPaid: ev.feesPaid,
    realizedPnl: ev.realizedPnl,
    realizedPnlPercent: ev.realizedPnlPercent,
    isWin: ev.isWin,
    exitReason: ev.exitReason,
    closedAt: ev.closedAt,
    openedAt: ev.openedAt,
    holdingDurationMinutes: ev.holdingDurationMinutes,
    isSelfApproved: true,
  };
}
