import React, { useEffect, useRef, useState } from "react";
import type { TraderRecord } from "../../services/exitExpectancy";
import type { ClassicId, ClassicRecords } from "../../services/classicStrategies";
import { rSigned } from "./LedgerBreakdown";
import { useLabFeed } from "./labFeed";
import { LabChip } from "./labUi";
import { RollingDigits } from "./motion";
import { isDailyCoinsView } from "./DailyCoinsCard";
import { classicByYear, isDailyLongView } from "./DailyLongCard";
import { isStocksLongView } from "./StocksLongCard";
import { isUsBreakoutView } from "./UsBreakoutCard";
import { isUsMomentumView } from "./UsMomentumCard";
import type { LabTab } from "./LabSummary";

// Lab → Today, first: the slower strategies as a deck of cards to swipe
// through. Each card is one strategy: whether it trades now, its replay's
// average a trade and how many trades that's over, each replayed year up or
// down, and its rules in a few lines. The numbers are the Lab's own records,
// the ones that decide whether it trades.

export interface LineupCard {
  id: "coin-breakout" | "us-breakout" | "funds-breakout" | "us-momentum";
  kicker: string;
  name: string;
  on: boolean;
  avgR: number;
  trades: number;
  since: string;
  /** Each replayed year with trades, oldest first: up or down. Empty until the yearly records load. */
  years: { year: string; r: number }[];
  rules: [string, string][];
}

/** A strategy's average a trade in each replayed year that had trades, oldest first. */
export function yearsOf(classic: ClassicRecords | undefined, id: ClassicId): { year: string; r: number }[] {
  if (!classic) return [];
  return [...classicByYear(classic).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([year, row]) => {
      const rec: TraderRecord | undefined = row[id];
      return rec && rec.trades > 0 ? [{ year, r: rec.totalR / rec.trades }] : [];
    });
}

const BREAKOUT_SELLS: [string, string] = ["Sells", "below its 20-day low, or at the stop 2 ATR under"];

/** The deck's cards, from the Lab's routes: one for each strategy whose gate the server has reported. */
export function useLineup(): LineupCard[] {
  const dc = useLabFeed("/api/daily-coins", isDailyCoinsView);
  const us = useLabFeed("/api/us-breakout", isUsBreakoutView);
  const funds = useLabFeed("/api/funds-breakout", isUsBreakoutView);
  const momentum = useLabFeed("/api/us-momentum", isUsMomentumView);
  const dl = useLabFeed("/api/daily-long", isDailyLongView);
  const sl = useLabFeed("/api/stocks-long", isStocksLongView);
  const cards: LineupCard[] = [];
  if (dc?.breakout) {
    cards.push({
      id: "coin-breakout", kicker: "COINS · DAILY", name: "Coin breakout 55/20", on: dc.breakout.on, avgR: dc.breakout.avgR, trades: dc.breakout.trades,
      since: "since 2018", years: yearsOf(dl?.classic ?? undefined, "breakout"),
      rules: [["On", "this year's biggest coins"], ["Buys", "a daily close above its 55-day high"], BREAKOUT_SELLS],
    });
  }
  if (us?.gate) {
    cards.push({
      id: "us-breakout", kicker: "US STOCKS · DAILY", name: "US breakout 55/20", on: us.gate.on, avgR: us.gate.avgR, trades: us.gate.trades,
      since: "since 2016", years: yearsOf(sl?.classic.us, "breakout"),
      rules: [["On", "this year's 20 biggest US stocks"], ["Buys", "above its 55-day high at 3:45 pm New York"], BREAKOUT_SELLS],
    });
  }
  if (funds?.gate) {
    cards.push({
      id: "funds-breakout", kicker: "US FUNDS · DAILY", name: "Funds breakout 55/20", on: funds.gate.on, avgR: funds.gate.avgR, trades: funds.gate.trades,
      since: "since 2016", years: yearsOf(sl?.classic.funds, "breakout"),
      rules: [["On", "16 funds: gold, silver, bonds, oil, the dollar and more"], ["Buys", "above its 55-day high at 3:45 pm New York"], BREAKOUT_SELLS],
    });
  }
  if (momentum?.gate) {
    cards.push({
      id: "us-momentum", kicker: "US STOCKS · WEEKLY", name: "US momentum, top 3", on: momentum.gate.on, avgR: momentum.gate.avgR, trades: momentum.gate.trades,
      since: "since 2016", years: yearsOf(sl?.classic.us, "momentum"),
      rules: [
        ["Holds", "the 3 of this year's 20 biggest US stocks that rose most over 90 sessions"],
        ["Only", "while SPY is above its 200-day average; the stop 3 ATR under"],
        ["Checks", "the week's last session, 3:45 pm New York"],
      ],
    });
  }
  return cards;
}

/** Where a card sits in the deck: the shown one in front, its neighbours peeking out each side, the rest hidden. */
function place(offset: number): React.CSSProperties {
  const side = Math.sign(offset);
  const far = Math.abs(offset);
  if (far === 0) return { transform: "none", opacity: 1, zIndex: 3 };
  if (far === 1) return { transform: `translateX(${side * 88}%) scale(0.86) rotateY(${-side * 14}deg)`, opacity: 0.5, zIndex: 2 };
  return { transform: `translateX(${side * 150}%) scale(0.7)`, opacity: 0, zIndex: 1, pointerEvents: "none" };
}

const Card: React.FC<{ card: LineupCard; shown: boolean; rolled: boolean; n: number; onOpen?: (tab: LabTab) => void }> = ({
  card,
  shown,
  rolled,
  n,
  onOpen,
}) => {
  const up = card.years.filter((y) => y.r > 0).length;
  // The average rolls up from zero each time the card comes to the front.
  const avg = rSigned(card.avgR);
  return (
    <article
      aria-hidden={!shown}
      aria-label={card.name}
      data-testid={`lineup-${card.id}`}
      className="nx-deck-card relative bg-surface border border-line rounded-[28px] p-5 flex flex-col overflow-hidden"
    >
      <span aria-hidden="true" className="nx-deck-numeral absolute right-4 top-2 font-display text-[80px] leading-none font-semibold text-inset">
        {String(n).padStart(2, "0")}
      </span>
      <div className="relative text-[11px] font-bold tracking-[0.1em] text-muted">{card.kicker}</div>
      <h3 className="relative m-0 mt-1 font-display text-[24px] leading-tight font-semibold">{card.name}</h3>
      <div className="mt-3">
        <LabChip status={card.on ? "trading" : "paused"}>{card.on ? "Trading on paper" : "Paused"}</LabChip>
      </div>
      <div className={`flex mt-3 font-display text-[48px] leading-none tracking-[-0.02em] tabular-nums ${card.avgR >= 0 ? "text-gain" : "text-loss"}`}>
        <RollingDigits text={rolled ? avg : avg.replace(/\d/g, "0")} />
      </div>
      <div className="text-xs text-muted mt-1">
        a trade on average, replayed {card.since} · {card.trades.toLocaleString("en-IN")} trades
      </div>
      {card.years.length > 0 && (
        <div className="mt-4" data-testid="lineup-years">
          <div className="flex gap-1 items-end h-6" aria-hidden="true">
            {card.years.map((y, i) => (
              <span
                key={y.year}
                title={`${y.year}: ${rSigned(y.r)}`}
                className={`flex-1 rounded-[4px] ${y.r > 0 ? "bg-gain h-6" : "bg-loss/70 h-3"} ${shown ? "nx-rise" : ""}`}
                style={{ animationDelay: `${200 + i * 60}ms` }}
              />
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-muted mt-1 tabular-nums">
            <span>{card.years[0].year}</span>
            <span className="font-semibold text-ink text-xs">
              {up} of {card.years.length} years up
            </span>
            <span>{card.years[card.years.length - 1].year}</span>
          </div>
        </div>
      )}
      <dl className="m-0 mt-4 flex flex-col gap-2">
        {card.rules.map(([k, v], i) => (
          <div key={k} className={`flex gap-3 text-[13px] leading-snug ${shown ? "nx-row-in" : ""}`} style={{ animationDelay: `${350 + i * 80}ms` }}>
            <dt className="w-14 shrink-0 font-semibold text-muted">{k}</dt>
            <dd className="m-0">{v}</dd>
          </div>
        ))}
      </dl>
      {onOpen && (
        <button
          type="button"
          tabIndex={shown ? 0 : -1}
          onClick={() => onOpen("records")}
          className="self-start mt-4 min-h-10 px-3.5 -ml-1 rounded-full text-[13px] font-semibold text-accent cursor-pointer hover:bg-accent-soft"
        >
          See its records ›
        </button>
      )}
    </article>
  );
};

/** The deck: swipe, tap the arrows or a dot. */
export const StrategyLineup: React.FC<{ onOpen?: (tab: LabTab) => void; cards?: LineupCard[] }> = ({ onOpen, cards: given }) => {
  const loaded = useLineup();
  const cards = given ?? loaded;
  const [at, setAt] = useState(0);
  const startX = useRef<number | null>(null);
  // The front card's average rolls up just after the deck shows (the digits don't roll on first show).
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 150);
    return () => clearTimeout(t);
  }, []);
  if (cards.length === 0) return null;
  const shown = Math.min(at, cards.length - 1);
  const go = (i: number) => setAt(Math.max(0, Math.min(cards.length - 1, i)));
  return (
    <section aria-label="The strategies" aria-roledescription="carousel" className="flex flex-col gap-3 -mx-1 px-1 overflow-hidden">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <div className="text-[11px] font-semibold text-muted uppercase tracking-[0.08em]">The strategies</div>
        <div className="text-xs text-muted tabular-nums" aria-live="polite">
          {shown + 1} of {cards.length}
        </div>
      </div>
      <div
        className="grid [perspective:1100px] touch-pan-y select-none"
        data-testid="lineup-deck"
        onPointerDown={(e) => (startX.current = e.clientX)}
        onPointerUp={(e) => {
          if (startX.current === null) return;
          const dx = e.clientX - startX.current;
          startX.current = null;
          if (dx < -40) go(shown + 1);
          else if (dx > 40) go(shown - 1);
        }}
        onPointerCancel={() => (startX.current = null)}
      >
        {cards.map((c, i) => (
          <div key={c.id} className="nx-deck-slot [grid-area:1/1] w-[88%] justify-self-center" style={place(i - shown)} data-testid={`lineup-slot-${c.id}`}>
            <Card card={c} shown={i === shown} rolled={ready && i === shown} n={i + 1} onOpen={onOpen} />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous strategy"
          disabled={shown === 0}
          onClick={() => go(shown - 1)}
          className="w-11 h-11 rounded-full border border-line bg-surface text-ink grid place-items-center cursor-pointer disabled:opacity-35 disabled:cursor-default"
        >
          ‹
        </button>
        <div className="flex items-center">
          {cards.map((c, i) => (
            <button
              key={c.id}
              type="button"
              aria-label={c.name}
              aria-current={i === shown ? "true" : undefined}
              onClick={() => go(i)}
              className="min-w-7 min-h-11 grid place-items-center cursor-pointer"
            >
              <span className={`nx-deck-dot block h-2 rounded-full ${i === shown ? "w-7 bg-accent" : "w-2 bg-line"}`} />
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Next strategy"
          disabled={shown === cards.length - 1}
          onClick={() => go(shown + 1)}
          className="w-11 h-11 rounded-full border border-line bg-surface text-ink grid place-items-center cursor-pointer disabled:opacity-35 disabled:cursor-default"
        >
          ›
        </button>
      </div>
    </section>
  );
};
