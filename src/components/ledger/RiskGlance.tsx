import React from "react";
import { ShieldCheck, ShieldX } from "lucide-react";
import type { Position, RiskCalculation } from "../../types";
import { Card } from "./ui";
import { formatMoney, formatPrice } from "./format";
import { atStop } from "./LedgerFloor";

// Book → Risk, first: three rings (today's loss limit left, what every open
// stop hitting would take of it, and the money in trades), then each open
// trade's loss at its stop.

const money = (n: number) => formatMoney(n, { decimals: 0 });

/** What every open trade's stop hitting would make or lose together, before fees, and that loss's share of today's limit. */
export function allStops(positions: Position[], limit: number): { net: number; share: number } {
  const net = positions.reduce((s, p) => s + atStop(p), 0);
  return { net, share: limit > 0 ? Math.min(100, (Math.max(0, -net) / limit) * 100) : 0 };
}

// Radii in px of the three rings in their 168 px box, outside in.
const RING_SIZES = [
  { inner: 71, outer: 84 },
  { inner: 54, outer: 67 },
  { inner: 37, outer: 50 },
];

const Ring: React.FC<{ pct: number; color: string; size: number; delayMs: number; testId: string }> = ({ pct, color, size, delayMs, testId }) => {
  const { inner, outer } = RING_SIZES[size];
  const mask = `radial-gradient(circle, transparent ${inner - 0.5}px, #000 ${inner}px, #000 ${outer}px, transparent ${outer + 0.5}px)`;
  return (
    <span
      data-testid={testId}
      className="absolute inset-0 rounded-full nx-risk-ring"
      style={
        {
          "--nx-ring": Math.max(0, Math.min(100, pct)).toFixed(1),
          background: `conic-gradient(${color} calc(var(--nx-ring) * 1%), color-mix(in srgb, ${color} 14%, transparent) 0)`,
          WebkitMaskImage: mask,
          maskImage: mask,
          animationDelay: `${delayMs}ms`,
        } as React.CSSProperties
      }
    />
  );
};

export const RiskGlance: React.FC<{ r: RiskCalculation; positions: Position[]; passing: boolean }> = ({ r, positions, passing }) => {
  const limit = r.hardDailyLossLimit;
  const left = Math.max(0, limit - r.currentDailyLoss);
  const stops = allStops(positions, limit);
  const inTrades = r.portfolioExposureFraction * 100;
  const Shield = passing ? ShieldCheck : ShieldX;
  return (
    <Card aria-label="Risk at a glance" className="flex items-center gap-3.5">
      <div className="relative w-[168px] h-[168px] shrink-0" aria-hidden="true">
        <Ring testId="ring-loss-left" pct={limit > 0 ? (left / limit) * 100 : 0} color="var(--nx-gain)" size={0} delayMs={150} />
        {positions.length > 0 && <Ring testId="ring-all-stops" pct={stops.share} color="var(--nx-warn)" size={1} delayMs={300} />}
        <Ring testId="ring-in-trades" pct={inTrades} color="var(--nx-accent)" size={2} delayMs={450} />
        <span
          className={`absolute left-1/2 top-1/2 w-11 h-11 -ml-[22px] -mt-[22px] rounded-full grid place-items-center nx-breathe ${
            passing ? "bg-gain/15 text-gain" : "bg-loss/15 text-loss"
          }`}
        >
          <Shield className="w-6 h-6" strokeWidth={1.8} />
        </span>
      </div>
      <div className="flex flex-col gap-3 min-w-0 text-xs leading-snug">
        <div className="flex gap-2" data-testid="glance-loss-left">
          <span className="w-2.5 h-2.5 mt-0.5 rounded-[3px] shrink-0 bg-gain" />
          <span>
            <b>{money(left)}</b> of today's {money(limit)} loss limit left
          </span>
        </div>
        {positions.length > 0 && (
          <div className="flex gap-2" data-testid="glance-all-stops">
            <span className="w-2.5 h-2.5 mt-0.5 rounded-[3px] shrink-0 bg-warn" />
            <span>
              <b>{Math.round(stops.share)}%</b> of the limit if every stop hit
            </span>
          </div>
        )}
        <div className="flex gap-2" data-testid="glance-in-trades">
          <span className="w-2.5 h-2.5 mt-0.5 rounded-[3px] shrink-0 bg-accent" />
          <span>
            <b>{inTrades.toFixed(0)}%</b> of the money in trades
          </span>
        </div>
      </div>
    </Card>
  );
};

/** Each open trade's result if its stop hit now, the biggest loss first, and all of them together. */
export const IfStopsHit: React.FC<{ positions: Position[]; limit: number }> = ({ positions, limit }) => {
  if (positions.length === 0) return null;
  const rows = positions.map((p) => ({ p, v: atStop(p) })).sort((a, b) => a.v - b.v);
  const biggest = Math.max(1, ...rows.map((x) => Math.max(0, -x.v)));
  const stops = allStops(positions, limit);
  return (
    <Card aria-label="If every stop hit now" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">If every stop hit now</span>
        <span className={`font-display text-xl tabular-nums ${stops.net < 0 ? "text-loss" : "text-gain"}`} data-testid="stops-total">
          {formatMoney(stops.net, { signed: true, decimals: 0 })}
        </span>
      </div>
      {rows.map(({ p, v }, i) => (
        <div key={p.id} data-testid="stop-row">
          <div className="flex justify-between gap-3 text-[13px] mb-1">
            <span>
              <b>{p.symbol}</b> <span className="text-muted">stop {formatPrice(p.stopLoss)}</span>
            </span>
            <span className={`font-bold tabular-nums ${v < 0 ? "text-loss" : "text-gain"}`}>
              {formatMoney(v, { signed: true, decimals: 0 })}
              {v >= 0 ? " locked in" : ""}
            </span>
          </div>
          {v < 0 && (
            <div className="h-2 rounded-full bg-inset" aria-hidden="true">
              <div className="h-full rounded-full bg-loss/75 nx-grow" style={{ width: `${((-v / biggest) * 100).toFixed(1)}%`, animationDelay: `${300 + i * 90}ms` }} />
            </div>
          )}
        </div>
      ))}
      <div className="text-xs text-muted leading-relaxed">
        Before fees. Stops seldom all hit on one day; this is the most today could cost from what's open
        {limit > 0 && stops.net < 0 ? `, ${Math.round(stops.share)}% of today's loss limit` : ""}.
      </div>
    </Card>
  );
};
