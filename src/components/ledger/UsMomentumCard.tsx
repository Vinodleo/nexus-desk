import React from "react";
import { Card } from "./ui";
import { pnlTone } from "./format";
import { rSigned } from "./LedgerBreakdown";
import { useLabFeed } from "./labFeed";
import { Fold, LabChip } from "./labUi";
import { CheckPicks, shortName, SlotsMeter, waitedForSlot, when, type DailyCoinsView } from "./DailyCoinsCard";

// Momentum, top 3, on US stocks (server/scanner/usMomentum.ts): the server's
// check on each week's last US session at 3:45 pm New York, this week's top 3
// and SPY's guard, what it bought, kept and sold, momentum's US slots in use,
// and the record since 2016 that decides whether it trades. Paper only.

export interface UsMomentumView {
  /** The last weekly check; marketUp and top are absent when it stopped early (no prices). */
  run: (NonNullable<DailyCoinsView["run"]> & { marketUp?: boolean; top?: { symbol: string; rise: number }[] }) | null;
  /** Its US record since 2016 and whether it trades; null before the stocks' replay has run. */
  gate: { trader: string; trades: number; avgR: number; on: boolean; wins?: number; winR?: number; lossR?: number } | null;
  /** US momentum trades open now against momentum's own US slots; null before the app has sent its settings. */
  slots: { used: number; max: number } | null;
  nextAt: number;
}

/** A reply this card can show (an older server has no such route). */
export const isUsMomentumView = (body: any): body is UsMomentumView => !!body && "gate" in body && "slots" in body && typeof body.nextAt === "number";

const pct = (rise: number) => `${rise >= 0 ? "+" : "−"}${Math.abs(rise * 100).toFixed(0)}%`;

export const UsMomentumCard: React.FC = () => {
  const view = useLabFeed("/api/us-momentum", isUsMomentumView);
  if (!view) return null;
  const { run, gate } = view;

  return (
    <Card aria-label="US momentum trades" className="flex flex-col gap-2">
      <div>
        <div className="text-sm font-semibold">US momentum, top 3 (paper)</div>
        <div className="text-xs tabular-nums text-muted" data-testid="momentum-status">
          {run ? `Last check ${when(run.at)} · next ${when(view.nextAt)}` : `First check ${when(view.nextAt)}`}
        </div>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums" data-testid="momentum-record">
        {gate ? (
          <>
            <span className="text-muted">
              Record since 2016: {gate.trades} trades · <span className={`font-semibold ${pnlTone(gate.avgR)}`}>{rSigned(gate.avgR)}</span>
            </span>
            <LabChip status={gate.on ? "trading" : "paused"}>{gate.on ? "Trading" : "Paused"}</LabChip>
          </>
        ) : (
          <span className="text-muted">Waits for the stocks' replay since 2016 to finish.</span>
        )}
      </div>

      {run?.marketUp !== undefined && (
        <div className="p-2.5 rounded-xl bg-inset flex flex-col gap-1.5" data-testid="momentum-top">
          <div className="text-xs">
            {run.marketUp ? (
              <>
                <span className="font-semibold text-gain">SPY above its 200-day average:</span> momentum holds this week's top 3.
              </>
            ) : (
              <>
                <span className="font-semibold text-loss">SPY below its 200-day average:</span> momentum holds nothing until it's back above.
              </>
            )}
          </div>
          {run.top && run.top.length > 0 && (
            <ol className="m-0 p-0 list-none flex flex-wrap gap-1.5">
              {run.top.map((t, k) => (
                <li key={t.symbol} className="px-2 py-0.5 rounded-full bg-surface border border-line text-xs tabular-nums">
                  <span className="text-muted">{k + 1}.</span> <span className="font-semibold">{shortName(t.symbol)}</span>{" "}
                  <span className="text-gain">{pct(t.rise)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {view.slots && (
        <SlotsMeter
          used={view.slots.used}
          max={view.slots.max}
          waited={waitedForSlot(run?.picks ?? [], "momentum")}
          label="Momentum"
          setting="US stocks"
          row="momentum trades at once"
          testId="momentum-slots"
        />
      )}

      {run && <CheckPicks run={run} testId="momentum-picks" empty="Nothing to buy or sell that week." />}

      <Fold title="How the weekly check works">
        <div className="text-xs text-muted leading-relaxed">
          On each week's last US trading day (usually Friday) at 3:45 pm New York (about 1:15 am Saturday in India, 2:15 am in winter), just
          before the close, the server ranks this year's 20 biggest US stocks by how much they rose over the last 90 trading days. The 3 that
          rose most are the week's picks, while SPY is above its 200-day average; none when it isn't. A pick not held is bought at the ask, with
          a stop 3 ATR below; one held that's no longer a pick is sold at the bid; one still a pick is kept. No target and no trailing stop:
          between checks only the stop can close a trade. Held overnight, for weeks, in fractions of a share, within your US limits, on
          momentum's own slots, after US breakout's check (one trade per stock). It trades only while its record since 2016 is positive over 10+
          trades.
        </div>
      </Fold>
    </Card>
  );
};
