import React, { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../services/apiClient";
import { liveTestLines, type LiveTestReport, type LiveTestRun } from "../../shared/liveTest";

// Settings → Connections → Test live order: one small real buy at CoinDCX
// and its sale (server/liveTest.ts), to see live orders work before any
// strategy trades real money. The desk stays on Paper meanwhile.

const button =
  "min-h-9 px-3.5 rounded-full border border-line text-[13px] font-semibold cursor-pointer disabled:opacity-60 disabled:cursor-default";

/** "SOLINR" → "SOL". */
const coinOf = (market: string) => market.replace(/INR$/, "");

export const LiveTestCard: React.FC<{ active: boolean }> = ({ active }) => {
  const [report, setReport] = useState<LiveTestReport | null>(null);
  const [market, setMarket] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"buy" | "sell" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/live/test-order");
      const data = await res.json();
      if (data?.success) setReport(data);
    } catch {}
  }, []);

  useEffect(() => {
    if (!active) {
      setConfirming(false);
      setError(null);
      return;
    }
    void load();
  }, [active, load]);

  // While the server reads CoinDCX's balances after an order, look again every 3 seconds; while a sale is pending, every 10.
  const settling = !!report?.run?.settling;
  const selling = report?.run?.status === "SELLING";
  useEffect(() => {
    if (!active || (!settling && !selling)) return;
    const t = setInterval(() => void load(), settling ? 3000 : 10_000);
    return () => clearInterval(t);
  }, [active, settling, selling, load]);

  const markets = report?.markets ?? [];
  const picked = markets.includes(market) ? market : markets[0] ?? "";

  const send = async (kind: "buy" | "sell") => {
    setBusy(kind);
    setError(null);
    setConfirming(false);
    try {
      const res = await apiFetch(kind === "buy" ? "/api/live/test-order" : "/api/live/test-order/sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "buy" ? { market: picked } : {}),
      });
      const data = await res.json();
      if (data?.success && data.run) setReport((r) => (r ? { ...r, run: data.run as LiveTestRun } : r));
      else setError(data?.error || "The server didn't take it.");
    } catch (err: any) {
      setError(err?.message || "Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  };

  // An older server, or not loaded yet: nothing to show.
  if (!report) return null;
  const run = report.run;
  const open = run && (run.status === "BOUGHT" || run.status === "SELLING");
  const ready = report.keys && report.liveEnabled && picked !== "" && !open && !settling;
  const amount = `₹${report.amountInr}`;
  const sub = !report.keys
    ? `Buys ${amount} of a coin for real, then sells it. Needs CoinDCX keys on the server.`
    : !report.liveEnabled
      ? `Buys ${amount} of a coin for real, then sells it. Live orders are blocked on the server (LIVE_TRADING_ENABLED): see docs/going-live.md.`
      : open
        ? `Your ${run!.coin} from the test is at CoinDCX.`
        : `Buys ${amount} of a coin for real, then you sell it here. The desk stays on Paper.`;

  return (
    <div className="py-2.5 border-b border-line text-sm">
      <div className="flex items-center justify-between gap-3 min-h-9">
        <div className="min-w-0">
          <div>Test live order</div>
          <div className="text-xs text-muted mt-0.5">{sub}</div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {run?.status === "BOUGHT" ? (
            <button type="button" className={button} disabled={busy !== null || settling} onClick={() => void send("sell")}>
              {busy === "sell" ? "Selling…" : "Sell it"}
            </button>
          ) : selling ? (
            <span className="text-xs text-muted">Selling…</span>
          ) : (
            <>
              {report.markets.length > 1 && ready && (
                <select
                  aria-label="Coin to test"
                  value={picked}
                  onChange={(e) => setMarket(e.target.value)}
                  className="min-h-9 rounded-full border border-line bg-surface px-2.5 text-[13px] text-ink"
                >
                  {report.markets.map((m) => (
                    <option key={m} value={m}>
                      {coinOf(m)}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" className={button} disabled={!ready || busy !== null} onClick={() => setConfirming(true)}>
                {busy === "buy" ? "Buying…" : `Buy ${amount}`}
              </button>
            </>
          )}
        </div>
      </div>
      {confirming && ready && (
        <div className="mt-2 -mx-3.5 px-3.5 py-2.5 text-xs leading-relaxed text-warn-ink bg-warn-soft">
          Buys {amount} of {coinOf(picked)} at CoinDCX with your money, now.{" "}
          <button type="button" onClick={() => void send("buy")} className="font-semibold underline cursor-pointer">
            Yes, buy
          </button>{" "}
          ·{" "}
          <button type="button" onClick={() => setConfirming(false)} className="font-semibold underline cursor-pointer">
            Cancel
          </button>
        </div>
      )}
      {run && (
        <ul className="mt-2 flex flex-col gap-1 text-xs text-muted leading-relaxed" aria-label="Test result">
          {liveTestLines(run).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {error && <div className="mt-2 text-xs text-loss">{error}</div>}
    </div>
  );
};
