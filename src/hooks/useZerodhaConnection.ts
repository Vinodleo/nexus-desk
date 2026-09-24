import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../services/apiClient";

export type ZerodhaStatus = "disconnected" | "connecting" | "connected" | "error";

// Zerodha connection state. A successful login redirects back to this
// same page with ?request_token=... appended (the redirect URL
// registered against your API key in Zerodha's developer console must
// point back here) — on mount, if that param is present, exchange it
// for a session immediately, then strip it from the URL.
export function useZerodhaConnection() {
  const [status, setStatus] = useState<ZerodhaStatus>("disconnected");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestToken = params.get("request_token");
    if (!requestToken) return;

    setStatus("connecting");
    apiFetch("/api/zerodha/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestToken }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.success) {
          setStatus("connected");
        } else {
          setStatus("error");
          setError(data?.error || "Zerodha login failed");
        }
        // Clean the request_token out of the URL either way, so a refresh
        // doesn't try to redeem an already-used (and by then invalid) token.
        params.delete("request_token");
        params.delete("action");
        params.delete("status");
        const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : "");
        window.history.replaceState({}, "", cleanUrl);
      })
      .catch((err) => {
        setStatus("error");
        setError(err?.message || "Zerodha login failed");
      });
  }, []);

  const connect = useCallback(async () => {
    try {
      setStatus("connecting");
      const res = await apiFetch("/api/zerodha/init", { method: "POST" });
      const data = await res.json();
      if (data?.loginUrl) {
        // Full-page redirect to Zerodha's own login page — 2FA and
        // everything happens on their site, never ours.
        window.location.href = data.loginUrl;
      } else {
        setStatus("error");
        setError(data?.error || "Could not start Zerodha login — check ZERODHA_API_KEY is set.");
      }
    } catch (err: any) {
      setStatus("error");
      setError(err?.message || "Could not reach the server.");
    }
  }, []);

  return { status, error, connect };
}
