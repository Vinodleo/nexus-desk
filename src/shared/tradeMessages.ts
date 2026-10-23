// The words of the trade pop-ups, shared by the server (Web Push, which
// reaches a locked phone) and the app (which shows the same pop-up for a
// trade it closes itself). A pop-up's tag names its trade, so the same close
// reported by both replaces rather than doubles.

import { isFundSymbol } from "./funds";
import { marketOf } from "./marketLimits";

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

/**
 * A slower strategy's own sale in its own words: they're recorded as
 * trailing-stop exits, though neither strategy trails its stop. Breakout's is
 * the close below the 20-day low, momentum's is leaving the week's top 3.
 * Undefined for any other exit (each place has its words for those).
 */
export function slowExitWords(exitReason: string, strategy?: string): string | undefined {
  if (exitReason !== "TRAILING_STOP") return undefined;
  return strategy === "breakout" ? "Below its 20-day low" : strategy === "momentum" ? "Left the top 3" : undefined;
}

const EXIT_WORDS: Record<string, string> = {
  TAKE_PROFIT: "Target reached",
  STOP_LOSS: "Stop loss",
  TRAILING_STOP: "Trailing stop",
  EXPIRY_TIME: "Time limit",
  MANUAL: "Closed by you",
};

/**
 * Which strategy a trade is, in the words the Book uses: the slower ones by
 * name (a fund's breakout apart from a stock's or a coin's), else the daily or
 * 5-minute traders.
 */
export function strategyLabel(t: { strategy?: string; symbol: string; timeframe?: string }): string {
  if (t.strategy === "momentum") return "US momentum";
  if (t.strategy === "breakout") return isFundSymbol(t.symbol) ? "Funds breakout" : marketOf(t.symbol) === "coins" ? "Coin breakout" : "US breakout";
  if (t.timeframe === "1d") return "Daily traders";
  return "5-minute traders";
}

/** A coin or stock without its market's suffix ("SOL", "NVDA"). */
const shortSymbol = (s: string) => s.replace(/\/INR$|\.US$|-EQ$/, "");
const rText = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}R`;
const slow = (strategy?: string) => strategy === "breakout" || strategy === "momentum";

function heldText(mins: number): string {
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `${Math.round(mins / 1440)} days`;
}

/**
 * Every trade pop-up has one shape (owner's ask, 23 Oct): a headline (what,
 * and for a close its result), then how much and what it risks or kept, then
 * why. Telegram adds a link to the desk.
 */
export function tradeOpenedMessage(
  p: { id: string; symbol: string; direction: "LONG" | "SHORT"; quantity: number; entryPrice: number; stopLoss: number; takeProfit: number; setupName?: string; timeframe?: string; strategy?: string; isLiveOrder?: boolean },
  by: "server" | "app"
): TradeMessage {
  const label = strategyLabel(p).replace(/^(Daily|5-minute) traders$/, (_, k: string) => k.toLowerCase());
  const risk = Math.abs(p.entryPrice - p.stopLoss) * p.quantity;
  const targetR = risk > 0 ? (Math.abs(p.takeProfit - p.entryPrice) * p.quantity) / risk : 0;
  const why =
    p.strategy === "breakout"
      ? "above its 55-day high"
      : p.strategy === "momentum"
        ? "one of the week's 3 strongest risers"
        : p.setupName
          ? `${p.setupName}'s ${p.timeframe === "1d" ? "daily " : ""}setup`
          : undefined;
  return {
    title: `${p.direction === "LONG" ? "Bought" : "Sold short"} ${shortSymbol(p.symbol)} · ${label} (${p.isLiveOrder ? "live" : "paper"})`,
    body: [
      `Size ${inr(p.quantity * p.entryPrice)} (${p.quantity} at ${inr(p.entryPrice)})`,
      `Stop ${inr(p.stopLoss)}: −1R is −${inr(risk)} · ${slow(p.strategy) ? "no target" : `target ${inr(p.takeProfit)} (+${targetR.toFixed(1)}R)`}`,
      [why && `Why: ${why}`, by === "server" && !slow(p.strategy) ? "opened by the server" : undefined].filter(Boolean).join(" · "),
    ]
      .filter(Boolean)
      .join("\n"),
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
  strategy?: string;
  timeframe?: string;
  /** What a loss at the first stop would have been, for the result in R; the fees, after which the result is. */
  riskAtOpen?: number;
  feesPaid?: number;
}): TradeMessage {
  const held = t.holdingDurationMinutes;
  const r = t.riskAtOpen && t.riskAtOpen > 0 ? t.realizedPnl / t.riskAtOpen : undefined;
  const exit = slowExitWords(t.exitReason, t.strategy) ?? EXIT_WORDS[t.exitReason] ?? t.exitReason;
  return {
    title: `${t.direction === "LONG" ? "Sold" : "Bought back"} ${shortSymbol(t.symbol)} · ${r !== undefined ? `${rText(r)}, ` : ""}${signed(t.realizedPnl)}`,
    body: [
      `${t.realizedPnl >= 0 ? "Kept" : "Lost"} ${inr(t.realizedPnl)}${t.feesPaid !== undefined ? ` after ${inr(t.feesPaid)} fees` : ""}${held !== undefined ? ` · held ${heldText(held)}` : ""}`,
      `${t.quantity} at ${inr(t.exitPrice)} · ${strategyLabel(t)}${t.setupName && !slow(t.strategy) ? ` · ${t.setupName}` : ""}`,
      `Why: ${exit.charAt(0).toLowerCase()}${exit.slice(1)}`,
    ].join("\n"),
    tag: `close-${t.positionId}`,
    url: "/",
  };
}

const pct = (from: number, to: number) => `${to >= from ? "+" : "−"}${((Math.abs(to - from) / from) * 100).toFixed(1)}%`;

/**
 * A swing setup waiting for you in the Queue. The autopilot never opens a
 * swing trade (it holds for days with a wide stop), and a proposal only
 * waits about ten minutes, so it's worth a pop-up. The tag is the market's,
 * so a repeat replaces the last one.
 */
export function swingWaitingMessage(
  p: { symbol: string; setup: { direction: "LONG" | "SHORT"; entryPrice: number; stopLoss: number; takeProfit: number; name?: string }; expiresAt?: number },
  now: number = Date.now()
): TradeMessage {
  const s = p.setup;
  const minsLeft = p.expiresAt !== undefined ? Math.max(1, Math.round((p.expiresAt - now) / 60_000)) : undefined;
  return {
    title: `Swing trade waiting: ${s.direction === "LONG" ? "buy" : "short"} ${p.symbol}`,
    body: `About ${inr(s.entryPrice)} · stop ${inr(s.stopLoss)} (${pct(s.entryPrice, s.stopLoss)}) · target ${inr(s.takeProfit)} (${pct(
      s.entryPrice,
      s.takeProfit
    )}) · holds up to 3 days${s.name ? ` · ${s.name}` : ""} · ${minsLeft !== undefined ? `approve in the Queue within ${minsLeft} min` : "approve in the Queue"}`,
    tag: `swing-${p.symbol}`,
    url: "/",
  };
}
