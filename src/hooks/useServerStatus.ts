import { useEffect, useState } from "react";
import { apiFetch } from "../services/apiClient";
import type { CoinDcxCheckReport } from "../shared/coinDcxCheck";

export interface ServerStatus {
  startedAt: number;
  uptimeSec: number;
  cloudRun: { service: string; revision: string } | null;
  storage: { dir: string; kept: boolean; note: string };
  scanner: { lastTickAt: number; lastCycleDoneAt: number; stalled: boolean };
  /** Angel One (Indian stocks); missing on an older server. */
  angelOne?: { configured: boolean; loggedIn: boolean; lastLoginAt: number; lastError: string | null; stocksKnown: number };
  /** Alpaca (US stocks, paper) and the USD/INR rate US prices are converted at; missing on an older server. */
  alpaca?: { configured: boolean; accountStatus: string | null; lastError: string | null };
  fx?: { usdInr: number; at: number; source: string } | null;
  /** Daily off-site backups of the saved state (server/backup.ts); missing on an older server. */
  backup?: { configured: boolean; /** The bucket settings the server can't see (names; absent from older servers). */ missing?: string[]; keepDays: number; lastAt: number | null; files: number; lastBytes: number; lastError: string | null; lastErrorAt: number | null };
  /** The check that the coins at CoinDCX match the live trades (server/coinDcxCheck.ts); missing on an older server. */
  coinDcxCheck?: CoinDcxCheckReport;
  /** Whether the server sends its errors to Sentry (server/errorReports.ts, SENTRY_DSN); missing on an older server. */
  errorReports?: { on: boolean };
  /** Gemini reviewing the server autopilot's trades, today (India time); missing on an older server. */
  reviewer?: {
    configured: boolean;
    dailyLimit: number;
    reviewed: number;
    taken: number;
    skipped: number;
    unreviewed: number;
    limitHits: number;
    /** Answers per model today; missing on an older server. */
    byModel?: Record<string, number>;
    limitReached: boolean;
    lastError: string | null;
  };
}

/** The server's host status, read while `active` (Settings open) and every minute. */
export function useServerStatus(active: boolean): ServerStatus | null {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const read = async () => {
      try {
        const res = await apiFetch("/api/server/status");
        if (!res.ok || cancelled) return;
        const body = await res.json();
        // An older server (or anything else answering) is ignored, not trusted.
        if (typeof body?.uptimeSec === "number" && typeof body?.storage?.kept === "boolean") setStatus(body as ServerStatus);
      } catch {}
    };
    void read();
    const timer = setInterval(read, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);
  return status;
}
