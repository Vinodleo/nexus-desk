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
