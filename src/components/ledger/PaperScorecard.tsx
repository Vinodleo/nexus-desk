import React from "react";
import type { HistoricalTrade, Position } from "../../types";
import {
  combineRecords,
  paperScore,
  PAPER_STRATEGIES,
  SCORECARD_FAIR_TRADES,
  SCORECARD_MIN_TRADES,
  type ExitKind,
  type PaperStrategy,
  type ReplayRecord,
} from "../../services/paperScorecard";
import { Card } from "./ui";
import { formatMoney } from "./format";
import { rSigned } from "./LedgerBreakdown";
import { useLabFeed } from "./labFeed";
import { CompareBars, LabChip, type LabStatus } from "./labUi";
import { isDailyCoinsView } from "./DailyCoinsCard";
import { isUsBreakoutView } from "./UsBreakoutCard";
import { isUsMomentumView } from "./UsMomentumCard";

// The Lab's scorecard (Records tab): each slower strategy's real paper
// trades so far next to what its replay expects (services/paperScorecard).
// It catches paper trading that doesn't behave like the replay long before
// the trades are enough to prove an edge.

type Gate = { trades: number; avgR: number; on?: boolean; wins?: number; winR?: number; lossR?: number };

/** A gate as a replay record, when the server sent its wins and the R won and lost. */
const asRecord = (g: Gate): ReplayRecord => ({ trades: g.trades, avgR: g.avgR, wins: g.wins ?? 0, winR: g.winR ?? 0, lossR: g.lossR ?? 0 });
const hasDetail = (g: Gate | null | undefined) => !!g && g.wins !== undefined;

const VERDICT: Record<"early" | "inLine" | "behind" | "ahead", { status: LabStatus; label: string }> = {
  early: { status: "off", label: "Too early" },
  inLine: { status: "passes", label: "In line" },
  behind: { status: "fails", label: "Behind the replay" },
  ahead: { status: "passes", label: "Ahead" },
};

/** How each strategy's exits read. */
const EXIT_WORDS = (strategy: PaperStrategy): Record<ExitKind, string> => ({
  stop: "at the stop",
  sale: strategy === "dailyCoins" ? "trailing stop" : strategy === "usMomentum" ? "sold at the weekly check" : "sold below the 20-day low",
  target: "at the target",
  time: "at the time limit",
  you: "closed by you",
});

const pct = (r: ReplayRecord) => Math.round((r.wins / r.trades) * 100);
const avgWin = (r: ReplayRecord) => (r.wins > 0 ? r.winR / r.wins : 0);
const avgLoss = (r: ReplayRecord) => (r.trades - r.wins > 0 ? r.lossR / (r.trades - r.wins) : 0);

export const PaperScorecard: React.FC<{ trades: HistoricalTrade[]; positions: Position[] }> = ({ trades, positions }) => {
  const dc = useLabFeed("/api/daily-coins", isDailyCoinsView);
  const us = useLabFeed("/api/us-breakout", isUsBreakoutView);
  const momentum = useLabFeed("/api/us-momentum", isUsMomentumView);
  if (!dc && !us && !momentum) return null;

  const replays: Record<PaperStrategy, { record: ReplayRecord; detail: boolean } | null> = {
    coinBreakout: dc?.breakout ? { record: asRecord(dc.breakout), detail: hasDetail(dc.breakout) } : null,
    usBreakout: us?.gate ? { record: asRecord(us.gate), detail: hasDetail(us.gate) } : null,
    usMomentum: momentum?.gate ? { record: asRecord(momentum.gate), detail: hasDetail(momentum.gate) } : null,
    // The daily traders that trade now, together.
    dailyCoins: (() => {
      const on = (dc?.traders ?? []).filter((t) => t.on);
      const record = combineRecords(on.map(asRecord));
      return record ? { record, detail: on.every(hasDetail) } : null;
    })(),
  };

  return (
    <Card aria-label="Paper trades against the replay" className="flex flex-col gap-1">
      <div className="text-sm font-semibold">Paper trades against the replay</div>
      <div className="text-xs text-muted leading-snug">
        Each slower strategy's real paper trades so far, next to what its replay expects. Ten trades are mostly luck; it takes about{" "}
        {SCORECARD_FAIR_TRADES} to tell.
      </div>
      <ul className="m-0 p-0 list-none flex flex-col">
        {PAPER_STRATEGIES.map(({ id, name }) => {
          const replay = replays[id];
          const score = paperScore(id, trades, positions, replay?.record ?? null);
          const verdict = VERDICT[score.verdict];
          const exits = Object.entries(score.exits).map(([kind, n]) => {
            const words = EXIT_WORDS(id)[kind as ExitKind];
            return kind === "stop" && score.gapped > 0 ? `${n} ${words} (${score.gapped} gapped past it)` : `${n} ${words}`;
          });
          return (
            <li key={id} className="py-2.5 border-b border-line last:border-b-0 flex flex-col gap-1.5" data-testid={`score-${id}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{name}</span>
                <LabChip status={verdict.status}>
                  {score.verdict === "early" && score.closed > 0 ? `${verdict.label} · ${score.closed} of ${SCORECARD_MIN_TRADES}` : verdict.label}
                </LabChip>
              </div>
              {score.closed === 0 ? (
                <div className="text-xs text-muted">
                  {score.open > 0 ? `${score.open} open, none closed yet.` : "No paper trades yet."}
                  {replay
                    ? ` The replay expects ${rSigned(replay.record.avgR)} a trade${replay.detail ? `, ${pct(replay.record)}% won` : ""}.`
                    : ""}
                </div>
              ) : (
                <>
                  <CompareBars
                    testId={`score-${id}-bars`}
                    rows={[
                      { label: "Paper", sub: `${score.closed} closed`, r: score.avgR!, strong: true },
                      ...(replay ? [{ label: "Replay", sub: `${replay.record.trades.toLocaleString("en-IN")} trades`, r: replay.record.avgR }] : []),
                    ]}
                  />
                  <div className="text-xs text-muted tabular-nums">
                    {score.open} open · {score.winPct}% won{replay?.detail ? ` (replay ${pct(replay.record)}%)` : ""} · P&L{" "}
                    {formatMoney(score.pnl, { signed: true, decimals: 0 })}
                  </div>
                  <div className="text-xs text-muted tabular-nums">
                    Average win {score.avgWinR !== null ? rSigned(score.avgWinR) : "—"}
                    {replay?.detail ? ` (replay ${rSigned(avgWin(replay.record))})` : ""} · average loss{" "}
                    {score.avgLossR !== null ? rSigned(score.avgLossR) : "—"}
                    {replay?.detail ? ` (replay ${rSigned(avgLoss(replay.record))})` : ""}
                  </div>
                  <div className="text-xs text-muted">Exits: {exits.join(" · ")}.</div>
                  {score.verdict !== "early" && score.closed < SCORECARD_FAIR_TRADES && (
                    <div className="text-[11px] text-muted">Under {SCORECARD_FAIR_TRADES} trades, luck still decides most of it.</div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
};
