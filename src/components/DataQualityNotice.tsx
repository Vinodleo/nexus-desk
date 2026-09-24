import React from "react";
import { AlertTriangle, Info } from "lucide-react";
import type { ProposalDataQuality } from "../types";

// Shows, on a trade proposal, how much of it rests on generated rather than
// observed data. Renders nothing when the proposal is fully real-data-backed.
export const DataQualityNotice: React.FC<{ quality?: ProposalDataQuality }> = ({ quality }) => {
  if (!quality) return null;
  const barsPct = Math.round(quality.syntheticBarShare * 100);
  const seededPct = Math.round(quality.seededExperienceShare * 100);
  if (barsPct === 0 && seededPct === 0) return null;

  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl bg-warn-soft text-warn-ink text-xs leading-relaxed">
      {barsPct > 0 && (
        <div className="flex gap-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0 text-loss mt-px" strokeWidth={1.8} />
          <span>
            <strong>Generated prices:</strong> {barsPct}% of the price history behind this signal is generated, not
            market data. Autopilot and live orders skip it.
          </span>
        </div>
      )}
      {seededPct > 0 && (
        <div className="flex gap-2.5">
          <Info className="w-4 h-4 shrink-0 text-warn mt-px" strokeWidth={1.8} />
          <span>
            <strong>Seeded memory:</strong> {seededPct}% of the similar past trades behind its win rate are generated
            starter examples, not your real trades.
          </span>
        </div>
      )}
    </div>
  );
};
