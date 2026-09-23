import React from "react";
import type { ProposalDataQuality } from "../types";

// Shows, on a trade proposal, how much of it rests on generated rather than
// observed data. Renders nothing when the proposal is fully real-data-backed.
export const DataQualityNotice: React.FC<{ quality?: ProposalDataQuality }> = ({ quality }) => {
  if (!quality) return null;
  const barsPct = Math.round(quality.syntheticBarShare * 100);
  const seededPct = Math.round(quality.seededExperienceShare * 100);
  if (barsPct === 0 && seededPct === 0) return null;

  return (
    <div className="text-[10px] font-mono rounded-lg px-2.5 py-1.5 border space-y-0.5 bg-rose-950/30 border-rose-800/40 text-rose-200">
      {barsPct > 0 && (
        <div>
          ⚠ Generated prices: {barsPct}% of the price history behind this signal is generated, not market
          data. Autopilot and live orders skip it.
        </div>
      )}
      {seededPct > 0 && (
        <div className="text-amber-200">
          ⓘ Seeded memory: {seededPct}% of the similar past trades behind its win rate are generated starter
          examples, not your real trades.
        </div>
      )}
    </div>
  );
};
