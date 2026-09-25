import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../services/apiClient";
import { shadowStore, type ShadowSignal } from "../services/shadowTracker";
import type { FailureInjectionState, PromotedLabModel, TradeProposal, TradingExecutionMode } from "../types";
import type { SymbolScanOutcome } from "../services/scanOutcome";

// The app's link to the server scanner. It sends the desk settings the
// server scans with, picks up every scan the server ran (live over the
// WebSocket, and on opening, the ones it missed while closed) and says
// where scanning is happening: on the server, or in this browser because
// the server isn't scanning.

export interface DeskSettings {
  equity: number;
  riskLimits: { maxOrderValueInr: number; maxAllowedExposureFraction: number };
  dailyRealizedPnl: number;
  autopilot: boolean;
  tradingMode: TradingExecutionMode;
  trailProfile: string;
  killSwitch: boolean;
  /** Losses in a row since the kill switch was last turned off. */
  lossStreak: number;
  scanning: boolean;
  failureState: FailureInjectionState;
  quarantines: Record<string, { quarantinedUntilMs: number }>;
  promotedModel: PromotedLabModel | null;
}

export interface ServerScanReport {
  at: number;
  outcomes: SymbolScanOutcome[];
  newProposals: TradeProposal[];
}

export type ScanLocation = "checking" | "server" | "browser";

const LAST_REPORT_KEY = "nexus_last_server_report_at";
const POLL_MS = 30_000;
const SHADOW_PULL_MS = 5 * 60_000;
/** On a first visit, only this much of the server's history is replayed. */
const FIRST_VISIT_WINDOW_MS = 15 * 60_000;

function readLastReportAt(): number {
  try {
    const v = Number(localStorage.getItem(LAST_REPORT_KEY));
    return v > 0 ? v : Date.now() - FIRST_VISIT_WINDOW_MS;
  } catch {
    return Date.now() - FIRST_VISIT_WINDOW_MS;
  }
}

export function useServerScanner(desk: DeskSettings, onReport: (report: ServerScanReport) => void) {
  const [location, setLocation] = useState<ScanLocation>("checking");
  const [lastScanAt, setLastScanAt] = useState(0);
  const [lastAutopilotOpenAt, setLastAutopilotOpenAt] = useState(0);
  const onReportRef = useRef(onReport);
  onReportRef.current = onReport;
  const lastAt = useRef(readLastReportAt());

  /** Hands each report to the app once, oldest first. */
  const take = useCallback((reports: ServerScanReport[]) => {
    for (const r of [...reports].sort((a, b) => a.at - b.at)) {
      if (r.at <= lastAt.current) continue;
      lastAt.current = r.at;
      try {
        localStorage.setItem(LAST_REPORT_KEY, String(r.at));
      } catch {}
      onReportRef.current(r);
    }
  }, []);

  // Desk settings: sent whenever they change (debounced), and again whenever
  // the server says it doesn't have them (a restart on a disk that isn't kept).
  const deskJson = JSON.stringify(desk);
  const deskJsonRef = useRef(deskJson);
  deskJsonRef.current = deskJson;
  const resending = useRef(false);

  const sendDesk = useCallback(async () => {
    try {
      const res = await apiFetch("/api/desk/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: deskJsonRef.current,
      });
      if (res.ok) {
        const status = (await res.json()).status;
        if (status) {
          setLocation(status.running ? "server" : "browser");
          setLastScanAt(status.lastScanAt ?? 0);
          setLastAutopilotOpenAt(status.lastAutopilotOpenAt ?? 0);
        }
      }
    } catch {}
  }, []);

  const applyStatus = useCallback(
    (status?: { running?: boolean; lastScanAt?: number; hasDesk?: boolean; lastAutopilotOpenAt?: number }) => {
      if (!status) return;
      setLocation(status.running ? "server" : "browser");
      setLastScanAt(status.lastScanAt ?? 0);
      setLastAutopilotOpenAt(status.lastAutopilotOpenAt ?? 0);
      if (status.hasDesk === false && !resending.current) {
        resending.current = true;
        void sendDesk().finally(() => (resending.current = false));
      }
    },
    [sendDesk]
  );

  useEffect(() => {
    const t = setTimeout(() => void sendDesk(), 1000);
    return () => clearTimeout(t);
  }, [deskJson, sendDesk]);

  // Scan reports: on open, on focus, and every 30s as a backstop to the WebSocket.
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await apiFetch(`/api/scanner/reports?since=${lastAt.current}`);
        if (!res.ok) {
          setLocation((l) => (l === "checking" ? "browser" : l));
          return;
        }
        const data = await res.json();
        applyStatus(data.status);
        take(data.reports ?? []);
      } catch {
        setLocation((l) => (l === "checking" ? "browser" : l));
      }
    };
    const onVisible = () => document.visibilityState === "visible" && void poll();
    void poll();
    const timer = setInterval(poll, POLL_MS);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [applyStatus, take]);

  // While the server scans, its tracked setups are the ones the Learning tab shows.
  useEffect(() => {
    if (location !== "server") return;
    const pull = async () => {
      try {
        const res = await apiFetch("/api/scanner/shadows");
        if (!res.ok) return;
        const list = (await res.json()).shadows as ShadowSignal[];
        if (Array.isArray(list)) shadowStore.replaceAll(list);
      } catch {}
    };
    void pull();
    const timer = setInterval(pull, SHADOW_PULL_MS);
    return () => clearInterval(timer);
  }, [location]);

  /** A report pushed over the WebSocket. */
  const handleLiveReport = useCallback(
    (r: ServerScanReport) => {
      setLocation("server");
      setLastScanAt(r.at);
      take([r]);
    },
    [take]
  );

  /** "Scan now" on the server; null if it couldn't. */
  const scanNow = useCallback(async (): Promise<ServerScanReport | null> => {
    try {
      const res = await apiFetch("/api/scanner/scan-now", { method: "POST" });
      if (!res.ok) return null;
      const report = (await res.json()).report as ServerScanReport;
      take([report]);
      return report;
    } catch {
      return null;
    }
  }, [take]);

  return { location, lastScanAt, lastAutopilotOpenAt, handleLiveReport, scanNow };
}
