import { useEffect, useRef } from "react";
import { apiFetch, authenticateSocket } from "../services/apiClient";
import type { DaemonCloseEvent } from "../services/daemonEvents";
import type { ServerScanReport } from "./useServerScanner";
import type { Position } from "../types";
import type { Quote } from "../shared/quotes";

export interface LiveExitUpdate {
  status: "OPEN" | "EXIT_PENDING" | "CLOSED" | "EXIT_FAILED";
  market: string;
  quantity: number;
  exitAttempts: number;
  lastError?: string;
}

export interface LiveFeedHandlers {
  /** A batch of prices ("BTC/INR" -> price) from the socket or the REST backstop. */
  onTick: (prices: Record<string, number>) => void;
  /** The server guardian closed a position. */
  onServerClose: (ev: DaemonCloseEvent) => void;
  /** Status change of a server-owned live exit. */
  onLiveExitUpdate: (rec: LiveExitUpdate) => void;
  /** The server scanner finished a scan. */
  onScanReport?: (report: ServerScanReport) => void;
  /** The server's autopilot opened a position. */
  onServerOpen?: (position: Position) => void;
  /** Best bid and ask for held coins ("BTC/INR" -> quote). */
  onQuote?: (quotes: Record<string, Quote>) => void;
}

const REST_BACKSTOP_MS = 6000;

// The app's single live connection to the server: the authenticated
// WebSocket (ticks, guardian closes, live-exit updates) plus a REST polling
// backstop for symbols whose socket channel goes quiet (a position could
// otherwise sit frozen at its entry price). Handlers are read through a ref,
// so the connection opens once but always calls the latest callbacks.
export function useLiveFeed(handlers: LiveFeedHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.onopen = () => {
      authenticateSocket(ws);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "TICK" && msg.data) {
          handlersRef.current.onTick(msg.data);
        } else if (msg.type === "DAEMON_POSITION_CLOSED" && msg.data?.positionId) {
          handlersRef.current.onServerClose(msg.data);
        } else if (msg.type === "LIVE_EXIT_UPDATE" && msg.data) {
          handlersRef.current.onLiveExitUpdate(msg.data);
        } else if (msg.type === "SCAN_REPORT" && msg.data?.at) {
          handlersRef.current.onScanReport?.(msg.data);
        } else if (msg.type === "POSITION_OPENED" && msg.data?.id) {
          handlersRef.current.onServerOpen?.(msg.data);
        } else if (msg.type === "QUOTE" && msg.data && typeof msg.data === "object") {
          handlersRef.current.onQuote?.(msg.data);
        }
      } catch (err) {
        console.error("WS parse error", err);
      }
    };

    const pollRestPrices = async () => {
      try {
        const res = await apiFetch("/api/coindcx/ticker");
        const tickers = await res.json();
        const prices: Record<string, number> = {};
        for (const t of tickers as { market: string; last_price: string }[]) {
          const sym = t.market.endsWith("USDT") ? t.market.replace("USDT", "/USDT") : t.market.replace("INR", "/INR");
          prices[sym] = parseFloat(t.last_price);
        }
        if (Object.keys(prices).length > 0) handlersRef.current.onTick(prices);
      } catch (err) {
        console.warn("[RESTPriceBackstop] poll failed", err);
      }
    };
    const restPollInterval = setInterval(pollRestPrices, REST_BACKSTOP_MS);

    return () => {
      ws.close();
      clearInterval(restPollInterval);
    };
  }, []);
}
