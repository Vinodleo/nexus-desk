import React from "react";
import { Card } from "./ui";
import { pnlTone } from "./format";
import { rSigned } from "./LedgerBreakdown";
import { useLabFeed } from "./labFeed";
import { Fold, LabChip } from "./labUi";
import { CheckPicks, SlotsMeter, waitedForSlot, when, type DailyCoinsView } from "./DailyCoinsCard";

// Breakout 55/20 on US stocks (server/scanner/usBreakout.ts): the server's
// check each US trading day at 3:45 pm New York, what it bought and sold,
// the US slots in use, and the record since 2016 that decides whether it
// trades. Paper only.

export interface UsBreakoutView {
  run: DailyCoinsView["run"];
  /** Its US record since 2016 and whether it trades; null before the stocks' replay has run. */
  gate: { trader: string; trades: number; avgR: number; on: boolean; wins?: number; winR?: number; lossR?: number } | null;
  /** US breakout trades open now against breakout's own US slots; null before the app has sent its settings. */
  slots: { used: number; max: number } | null;
  nextAt: number;
}

/** A reply this card can show (an older server has no such route). */
export const isUsBreakoutView = (body: any): body is UsBreakoutView => !!body && "gate" in body && "slots" in body && typeof body.nextAt === "number";

export const UsBreakoutCard: React.FC = () => {
  const view = useLabFeed("/api/us-breakout", isUsBreakoutView);
  if (!view) return null;
  const { run, gate } = view;

  return (
    <Card aria-label="US breakout trades" className="flex flex-col gap-2">
      <div>
        <div className="text-sm font-semibold">US breakout 55/20 (paper)</div>
        <div className="text-xs tabular-nums text-muted" data-testid="us-status">
          {run ? `Last check ${when(run.at)} · ${run.coins} stocks · next ${when(view.nextAt)}` : `First check ${when(view.nextAt)}`}
        </div>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs tabular-nums" data-testid="us-record">
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

      {view.slots && (
        <SlotsMeter
          used={view.slots.used}
          max={view.slots.max}
          waited={waitedForSlot(run?.picks ?? [], "breakout")}
          label="Breakout"
          setting="US stocks"
          row="breakout trades at once"
          testId="us-slots"
        />
      )}

      {run && <CheckPicks run={run} testId="us-picks" empty="No breakouts that day." />}

      <Fold title="How the US check works">
        <div className="text-xs text-muted leading-relaxed">
          Each US trading day at 3:45 pm New York (about 1:15 am in India, 2:15 am in winter), just before the close, the server checks this
          year's 20 biggest US stocks. One priced above its last 55 days' high is bought at the ask, with a stop 2 ATR below; one held and
          priced below its last 20 days' low is sold at the bid. No target and no trailing stop. Trades are held overnight, for weeks, in
          fractions of a share, within your US limits, on breakout's own slots. It trades only while its record since 2016 is positive
          over 10+ trades.
        </div>
      </Fold>
    </Card>
  );
};
