// Number formatting for the Private Ledger screens. Indian digit grouping
// throughout, and a real minus sign (−) so negative amounts line up.

import type { HistoricalTrade } from "../../types";

const MINUS = "−";

/**
 * For a stop exit: how far past the stop the position actually sold, as a %
 * of the stop (0 when it sold at or better than the stop). Null when the
 * trade didn't close on its stop or predates recording these.
 */
export function stopSlip(t: HistoricalTrade): { pct: number } | null {
  if (t.exitReason !== "STOP_LOSS" && t.exitReason !== "TRAILING_STOP") return null;
  if (t.stopAtExit === undefined || t.fillAtExit === undefined || !(t.stopAtExit > 0)) return null;
  const worse = t.direction === "LONG" ? t.stopAtExit - t.fillAtExit : t.fillAtExit - t.stopAtExit;
  return { pct: Math.max(0, (worse / t.stopAtExit) * 100) };
}

/**
 * What the entry cost next to the signal: how far the price paid was from the
 * price the signal came from, as a % of it. Positive is worse (a long bought
 * higher); negative is better. Null for trades from before this was recorded.
 */
export function entrySlip(t: HistoricalTrade): { pct: number } | null {
  if (!(t.signalPrice !== undefined && t.signalPrice > 0) || !(t.entryPrice > 0)) return null;
  const worse = t.direction === "LONG" ? t.entryPrice - t.signalPrice : t.signalPrice - t.entryPrice;
  return { pct: (worse / t.signalPrice) * 100 };
}

/** How a trade closed, in words. */
export const EXIT_LABEL: Record<HistoricalTrade["exitReason"], string> = {
  TAKE_PROFIT: "Take profit",
  STOP_LOSS: "Stop loss",
  TRAILING_STOP: "Trailing stop",
  MANUAL: "Closed by you",
  EXPIRY_TIME: "Time limit",
};

function grouped(value: number, decimals: number): string {
  return Math.abs(value).toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** ₹1,23,456.78 — with a leading + when `signed` and the amount is positive. */
export function formatMoney(value: number, opts: { signed?: boolean; decimals?: number } = {}): string {
  const v = Number.isFinite(value) ? value : 0;
  const body = `₹${grouped(v, opts.decimals ?? 2)}`;
  if (v < 0 && Math.abs(v) >= 0.005) return `${MINUS}${body}`;
  if (opts.signed && v >= 0.005) return `+${body}`;
  return body;
}

/** A market price: whole rupees for large prices, more decimals for small ones. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const decimals = abs >= 10000 ? 0 : abs >= 1 ? 2 : 4;
  return grouped(value, decimals);
}

/** +0.33% / −1.20% */
export function formatPct(value: number, opts: { signed?: boolean; decimals?: number } = {}): string {
  const v = Number.isFinite(value) ? value : 0;
  const body = `${Math.abs(v).toFixed(opts.decimals ?? 2)}%`;
  if (v < 0 && Math.abs(v) >= 0.005) return `${MINUS}${body}`;
  if (opts.signed !== false && v >= 0.005) return `+${body}`;
  return body;
}

/** Text colour class for a gain or loss. Zero stays neutral. */
export function pnlTone(value: number): string {
  if (value > 0.004) return "text-gain";
  if (value < -0.004) return "text-loss";
  return "text-ink";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** India is UTC+5:30 all year: a moment's date and clock there, read with the UTC getters. */
const inIndia = (ms: number) => new Date(ms + 330 * 60_000);

/** A moment's day in India time: "Fri 23 Oct". */
export function indiaDay(ms: number): string {
  const d = inIndia(ms);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** A moment's time of day in India: "4:10 pm", or "4:10:05 pm" with seconds. */
export function indiaClock(ms: number, seconds = false): string {
  const d = inIndia(ms);
  const h = d.getUTCHours();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h % 12 || 12}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ""} ${h < 12 ? "am" : "pm"}`;
}
