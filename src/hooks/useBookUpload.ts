import { useEffect, type MutableRefObject } from "react";
import { apiFetch } from "../services/apiClient";
import type { HistoricalTrade } from "../types";

// The server's trade book holds every close (server/tradeBook.ts). The app
// uploads the closes it holds that the book may not: from before the book
// was kept, and any made while the server couldn't be reached. Once a start,
// shortly after it; the book keeps one copy of each.

const UPLOADED_KEY = "nexus_book_uploaded_until";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Closes per request (well under the server's 100 KB limit on a request). */
const BATCH = 100;

/** The closes to upload: those since a day before the last upload (every one the first time), with a close time. */
export function closesToUpload(trades: HistoricalTrade[], uploadedUntil: number): HistoricalTrade[] {
  const from = uploadedUntil > 0 ? uploadedUntil - DAY_MS : 0;
  return trades.filter((t) => Number.isFinite(t.closedAtMs) && (t.closedAtMs as number) > from);
}

/** Only what the book keeps (the autopsy's long text stays on the phone). */
const forBook = ({ autopsy: _autopsy, ...t }: HistoricalTrade) => t;

/** Uploads the closes since the last upload; true once every batch is in (then remembered). */
export async function uploadCloses(trades: HistoricalTrade[]): Promise<boolean> {
  let until = 0;
  try {
    until = Number(localStorage.getItem(UPLOADED_KEY)) || 0;
  } catch {}
  const send = closesToUpload(trades, until);
  if (send.length === 0) return true;
  for (let i = 0; i < send.length; i += BATCH) {
    try {
      const res = await apiFetch("/api/book/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trades: send.slice(i, i + BATCH).map(forBook) }),
      });
      if (!res.ok) return false;
    } catch {
      return false;
    }
  }
  try {
    localStorage.setItem(UPLOADED_KEY, String(Math.max(...send.map((t) => t.closedAtMs as number))));
  } catch {}
  return true;
}

/** Shortly after the app starts, uploads its closes the server's book may not hold. */
export function useBookUpload(closedTradesRef: MutableRefObject<HistoricalTrade[]>, delayMs = 5000): void {
  useEffect(() => {
    const timer = setTimeout(() => void uploadCloses(closedTradesRef.current), delayMs);
    return () => clearTimeout(timer);
  }, [closedTradesRef, delayMs]);
}
