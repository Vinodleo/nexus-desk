import type { ServerStatus } from "../hooks/useServerStatus";

export type ReviewerBadge = "checking" | "off" | "problem" | "limit" | "working" | "ready";

/** Settings' Gemini row: a one-line summary of today's reviews and its badge. */
export function reviewerSummary(status: ServerStatus | null): { sub: string; badge: ReviewerBadge } {
  const r = status?.reviewer;
  if (!status) return { sub: "Gemini's second opinion on autopilot trades", badge: "checking" };
  if (!r?.configured) {
    return { sub: "Optional: add GEMINI_API_KEY on the server and Gemini reviews each autopilot trade before it opens", badge: "off" };
  }
  const parts = [`Today ${r.reviewed}/${r.dailyLimit} reviewed`, `${r.taken} taken`, `${r.skipped} skipped`];
  if (r.unreviewed > 0) parts.push(`${r.unreviewed} went ahead unreviewed`);
  if (r.limitHits > 0) parts.push(`Google's limit hit ${r.limitHits}×`);
  const line = parts.join(" · ");
  if (r.limitReached) return { sub: line, badge: "limit" };
  if (r.lastError) return { sub: `${r.lastError} · ${line}`, badge: "problem" };
  if (r.reviewed === 0) return { sub: `${line} · reviews each trade the autopilot is about to open`, badge: "ready" };
  return { sub: line, badge: "working" };
}
