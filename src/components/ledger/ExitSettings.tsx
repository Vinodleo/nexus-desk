import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { Card } from "./ui";
import { TRAIL_PROFILES, type TrailProfileId } from "../../shared/trailingStop";
import type { ProfileResult } from "../../services/exitComparison";

export interface ExitSettingsProps {
  profile: TrailProfileId;
  onChange: (p: TrailProfileId) => void;
  /** Runs the comparison (history download + replay). */
  onCompare: () => Promise<{ results: ProfileResult[]; coins: number }>;
}

const signedR = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;

const DESCRIPTION: Record<TrailProfileId, string> = {
  tight: "Locks in gains early; small wins, fewer give-backs",
  balanced: "Starts trailing later, keeps more room",
  patient: "Trails only well into profit; lets trades breathe",
  fixed: "No trailing: the original stop and target",
};

/**
 * Which trailing stop new trades use, with a comparison on history: every
 * setup the live panel would have taken, played out under each profile.
 */
export const ExitSettings: React.FC<ExitSettingsProps> = ({ profile, onChange, onCompare }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ results: ProfileResult[]; coins: number } | null>(null);

  const compare = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await onCompare());
    } catch (err: any) {
      setError(err?.message || "Comparison failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const results = data?.results ?? [];
  const best = results.reduce<ProfileResult | null>((a, r) => (r.trades > 0 && (!a || r.expectancyR > a.expectancyR) ? r : a), null);

  return (
    <Card aria-label="Exit settings" className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-semibold">Trailing stop</div>
        <div className="text-xs text-muted mt-0.5 leading-relaxed">
          How new trades protect gains. In use: <strong className="text-ink">{TRAIL_PROFILES[profile].label}</strong>. Compare them on
          recent history to see which earns more per trade, not just which wins more often.
        </div>
      </div>

      {results.length > 0 && (
        <div className="flex flex-col" role="table" aria-label="Exit settings compared">
          <div role="row" className="grid grid-cols-[1fr_auto_auto_auto] gap-3 text-[11px] text-muted pb-1.5 border-b border-line">
            <span role="columnheader">Setting</span>
            <span role="columnheader" className="text-right w-11">Won</span>
            <span role="columnheader" className="text-right w-24">Avg win / loss</span>
            <span role="columnheader" className="text-right w-16">Per trade</span>
          </div>
          {results.map((r) => (
            <div role="row" key={r.profile} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center py-2 border-b border-line last:border-b-0 text-[13px] tabular-nums">
              <span role="cell" className="min-w-0">
                <span className="font-semibold">{r.label}</span>
                {best?.profile === r.profile && <span className="ml-1.5 text-[11px] text-gain font-semibold">best</span>}
                <span className="block text-[11px] text-muted">{DESCRIPTION[r.profile]}</span>
                {r.profile === profile ? (
                  <span className="block text-[11px] text-gain font-semibold mt-0.5">In use</span>
                ) : (
                  <button type="button" onClick={() => onChange(r.profile)} className="mt-1 text-[12px] font-semibold text-accent underline cursor-pointer">
                    Use this
                  </button>
                )}
              </span>
              <span role="cell" className="text-right w-11">{r.winPct}%</span>
              <span role="cell" className="text-right w-24">
                <span className="text-gain">{signedR(r.avgWinR)}</span> / <span className="text-loss">{signedR(r.avgLossR)}</span>
              </span>
              <span role="cell" className={`text-right w-16 font-semibold ${r.expectancyR >= 0 ? "text-gain" : "text-loss"}`}>{signedR(r.expectancyR)}</span>
            </div>
          ))}
        </div>
      )}

      {data && (
        <p className="m-0 text-xs text-muted leading-relaxed">
          {results[0]?.trades ?? 0} trades the panel would have taken on {data.coins} coins over about 10 days of 5-minute candles, each
          played out under every setting with the live exit rules. R is the trade's initial risk; results are after fees and assume the
          worst order of moves inside each candle.
        </p>
      )}
      {error && <div className="text-xs text-loss">{error}</div>}

      <button
        type="button"
        onClick={compare}
        disabled={busy}
        className="min-h-11 rounded-full border border-line bg-surface text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
      >
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        {busy ? "Comparing…" : data ? "Compare again" : "Compare on history"}
      </button>
    </Card>
  );
};
