import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../services/apiClient";
import type {
  CoinDcxAccountBalance,
  CoinDcxServerStatus,
  ExecutionToast,
  TradingExecutionMode,
} from "../types";

const EMPTY_BALANCE: CoinDcxAccountBalance = {
  totalInr: 0,
  availableInr: 0,
  lockedInr: 0,
  totalUsdt: 0,
  availableUsdt: 0,
  lockedUsdt: 0,
  loading: false,
};

// Paper/live mode, the server's CoinDCX credential + live-limit status, and
// live account balances. CoinDCX keys live only on the server; the client
// just sees whether they're configured.
export function useCoinDcxAccount(notify: (toast: ExecutionToast) => void) {
  const [tradingMode, setTradingMode] = useState<TradingExecutionMode>(() => {
    try {
      return (localStorage.getItem("nexus_trading_mode") as TradingExecutionMode) || "PAPER";
    } catch {
      return "PAPER";
    }
  });
  const [coinDcxStatus, setCoinDcxStatus] = useState<CoinDcxServerStatus | null>(null);
  const [coinDcxBalance, setCoinDcxBalance] = useState<CoinDcxAccountBalance>(EMPTY_BALANCE);

  const fetchCoinDcxBalance = useCallback(async () => {
    setCoinDcxBalance((prev) => ({ ...prev, loading: true, error: undefined }));
    try {
      const res = await apiFetch("/api/coindcx/balances", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setCoinDcxBalance({
          totalInr: Number(data.totalInr || 0),
          availableInr: Number(data.availableInr || 0),
          lockedInr: Number(data.lockedInr || 0),
          totalUsdt: Number(data.totalUsdt || 0),
          availableUsdt: Number(data.availableUsdt || 0),
          lockedUsdt: Number(data.lockedUsdt || 0),
          loading: false,
          keyMasked: data.keyMasked,
          lastUpdated: new Date().toLocaleTimeString(),
        });
        return { success: true, data };
      }
      setCoinDcxBalance((prev) => ({
        ...prev,
        loading: false,
        error: data.error || "Failed to fetch balances from CoinDCX",
      }));
      return { success: false, error: data.error };
    } catch (err: any) {
      setCoinDcxBalance((prev) => ({
        ...prev,
        loading: false,
        error: err.message || "Network error fetching CoinDCX balance",
      }));
      return { success: false, error: err.message };
    }
  }, []);

  const refreshCoinDcxStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/api/coindcx/status");
      const data = await res.json();
      if (data.success) setCoinDcxStatus(data);
    } catch (err) {
      console.warn("[CoinDCX] Failed to load server credential status", err);
    }
  }, []);

  useEffect(() => {
    // Earlier builds kept the CoinDCX key and secret in localStorage; purge them.
    try {
      localStorage.removeItem("coindcx_api_key");
      localStorage.removeItem("coindcx_api_secret");
    } catch {}
    refreshCoinDcxStatus();
  }, [refreshCoinDcxStatus]);

  // Poll balances once on mount if the session starts in live mode.
  useEffect(() => {
    if (tradingMode === "LIVE_COINDCX") fetchCoinDcxBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleTradingMode = useCallback(
    (newMode: TradingExecutionMode) => {
      setTradingMode(newMode);
      try {
        localStorage.setItem("nexus_trading_mode", newMode);
      } catch {}
      if (newMode === "LIVE_COINDCX") {
        fetchCoinDcxBalance();
        notify({
          id: `toast-${Date.now()}`,
          title: "⚡ LIVE COINDCX MODE ENGAGED",
          message:
            "Live exchange order routing activated. Polling real account balances from CoinDCX API (/exchange/v1/users/balances).",
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
      } else {
        notify({
          id: `toast-${Date.now()}`,
          title: "🛡️ PAPER SIMULATION MODE ACTIVE",
          message: "Switched to Paper Trading. Orders execute against the local book with simulated slippage and fees.",
          type: "SUCCESS",
          timestamp: new Date().toLocaleTimeString(),
        });
      }
    },
    [fetchCoinDcxBalance, notify]
  );

  return {
    tradingMode,
    handleToggleTradingMode,
    coinDcxStatus,
    refreshCoinDcxStatus,
    coinDcxBalance,
    fetchCoinDcxBalance,
  };
}
