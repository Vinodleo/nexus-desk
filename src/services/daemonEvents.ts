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
  stopAtExit?: number;
  fillAtExit?: number;
  riskAtOpen?: number;
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function daemonEventToTrade(ev: DaemonCloseEvent): HistoricalTrade {
  // The guardian sends ISO times; the Book sorts and groups by the ms ones.
  const closedAtMs = Date.parse(ev.closedAt);
  const openedAtMs = Date.parse(ev.openedAt);
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
    closedAt: Number.isFinite(closedAtMs) ? hhmm(closedAtMs) : ev.closedAt,
    openedAt: Number.isFinite(openedAtMs) ? hhmm(openedAtMs) : ev.openedAt,
    ...(Number.isFinite(closedAtMs) ? { closedAtMs } : {}),
    ...(Number.isFinite(openedAtMs) ? { openedAtMs } : {}),
    holdingDurationMinutes: ev.holdingDurationMinutes,
    ...(ev.stopAtExit !== undefined ? { stopAtExit: ev.stopAtExit } : {}),
    ...(ev.fillAtExit !== undefined ? { fillAtExit: ev.fillAtExit } : {}),
    ...(ev.riskAtOpen !== undefined ? { riskAtOpen: ev.riskAtOpen } : {}),
    isSelfApproved: true,
  };
}
