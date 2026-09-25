// The words of the trade pop-ups, shared by the server (Web Push, which
// reaches a locked phone) and the app (which shows the same pop-up for a
// trade it closes itself). A pop-up's tag names its trade, so the same close
// reported by both replaces rather than doubles.

export interface TradeMessage {
  title: string;
  body: string;
  /** Replaces an earlier pop-up with the same tag instead of stacking. */
  tag: string;
  /** Opened when the pop-up is tapped. */
  url: string;
}

const inr = (n: number) => `₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: Math.abs(n) >= 100 ? 2 : 4 })}`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${inr(n)}`;

const EXIT_WORDS: Record<string, string> = {
  TAKE_PROFIT: "Target reached",
  STOP_LOSS: "Stop loss",
  TRAILING_STOP: "Trailing stop",
  EXPIRY_TIME: "Time limit",
  MANUAL: "Closed by you",
};

export function tradeOpenedMessage(
  p: { id: string; symbol: string; direction: "LONG" | "SHORT"; quantity: number; entryPrice: number; stopLoss: number; takeProfit: number; setupName?: string },
  by: "server" | "app"
): TradeMessage {
  return {
    title: `${p.direction === "LONG" ? "Bought" : "Sold short"} ${p.symbol}`,
    body: `${p.quantity} @ ${inr(p.entryPrice)} (${inr(p.quantity * p.entryPrice)}) · stop ${inr(p.stopLoss)} · target ${inr(p.takeProfit)}${
      p.setupName ? ` · ${p.setupName}` : ""
    }${by === "server" ? " · opened by the server" : ""}`,
    tag: `open-${p.id}`,
    url: "/",
  };
}

export function tradeClosedMessage(t: {
  positionId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  quantity: number;
  exitPrice: number;
  realizedPnl: number;
  exitReason: string;
  holdingDurationMinutes?: number;
  setupName?: string;
}): TradeMessage {
  const held = t.holdingDurationMinutes;
  return {
    title: `${t.symbol} closed ${signed(t.realizedPnl)}`,
    body: `${EXIT_WORDS[t.exitReason] ?? t.exitReason} · ${t.direction === "LONG" ? "sold" : "bought back"} ${t.quantity} @ ${inr(t.exitPrice)}${
      held !== undefined ? ` · held ${held < 60 ? `${held} min` : `${Math.floor(held / 60)} h ${held % 60} min`}` : ""
    }${t.setupName ? ` · ${t.setupName}` : ""}`,
    tag: `close-${t.positionId}`,
    url: "/",
  };
}
