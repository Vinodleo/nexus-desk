import React from "react";

// While the desk loads: the name, a short rising run of candles that grow
// one after another (and again, for as long as it waits), and what it's
// doing. The motion is CSS (nx-candle in index.css); with reduced motion the
// candles just stand there.

/** Each candle's wick and body, low to high, as % of the row's height, and whether it closed up. */
const CANDLES: { wick: [number, number]; body: [number, number]; up: boolean }[] = [
  { wick: [16, 58], body: [26, 48], up: true },
  { wick: [26, 70], body: [40, 62], up: true },
  { wick: [34, 66], body: [42, 56], up: false },
  { wick: [30, 80], body: [44, 74], up: true },
  { wick: [46, 86], body: [58, 80], up: true },
  { wick: [44, 82], body: [52, 68], up: false },
  { wick: [56, 98], body: [64, 92], up: true },
];

const span = ([lo, hi]: [number, number]): React.CSSProperties => ({ bottom: `${lo}%`, top: `${100 - hi}%` });

export const LoadingScreen: React.FC<{ message?: string }> = ({ message = "Opening the desk…" }) => (
  <div className="min-h-screen bg-canvas text-ink font-ui flex flex-col items-center justify-center gap-4" role="status">
    <div className="font-display text-[28px] font-semibold">Nexus Desk</div>
    <div className="flex gap-[9px] h-12" aria-hidden="true" data-testid="loading-candles">
      {CANDLES.map((c, i) => (
        <span key={i} className={`relative w-2 ${c.up ? "text-gain" : "text-loss"}`} style={{ ["--i" as string]: i }}>
          <span className="absolute left-[3.25px] w-[1.5px] rounded-sm bg-current nx-candle nx-candle-wick" style={span(c.wick)} />
          <span className="absolute inset-x-0 rounded-[2px] bg-current nx-candle nx-candle-body" style={span(c.body)} />
        </span>
      ))}
    </div>
    <div className="text-sm text-muted">{message}</div>
  </div>
);
