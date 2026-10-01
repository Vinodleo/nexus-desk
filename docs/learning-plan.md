# Making the traders learn

Noted 30 Sept at the owner's request. **Nothing here is built yet.** The owner's call is
to gather 3–4 weeks of data first, then judge the traders and decide. Build these in
order, one PR each, and only when the owner asks.

The traders' own rules (entry, stop, target) are fixed. What can learn is the desk around
them: which traders to trust, when, and with how much money. With only a handful of
trades, "learning from each trade" mostly learns luck, so every step below waits for
enough setups and checks itself on data it wasn't picked from.

## Already learning (built)

- **Pausing and un-pausing:** "Traders with your exits" (`src/services/exitExpectancy.ts`)
  replays each trader's setups over the last 30 days under the live exits. A trader
  judged under `MIN_EDGE_R`, or with under `MIN_TRADER_TRADES` (10) setups in a market,
  doesn't trade there (`src/services/calibration.ts`). It starts again by itself once
  its record turns positive.
- **Win-chance check:** `src/services/calibration.ts` measures what each confidence
  score really led to, so a trade opens only if scores like it have paid after costs.
- **The scoring table:** `src/services/conditionModel.ts` learns which conditions helped
  or hurt each trader in each market (market mood, Bitcoin's last hour, time of day,
  volume, trend strength, RSI) and feeds that into the confidence score. Thin rows are
  pulled toward no effect.
- **The Lab:** tunes desk-wide settings on coin history; a promoted result raises the
  minimum confidence score (`requiredMetaConfidence` in `marketScannerService.ts`).
- **Traders over two years (Lab, 1 Oct):** the server replays every trader on two years
  of 5-minute candles in every market, under all four trailing stops (`server/history/`,
  `src/services/historyReplay.ts`). It judges traders and exits on years, not 30 days,
  without waiting; the steps below can be tested on it before they go live.

## 1. Condition filters (first)

Already in CLAUDE.md's plans. Skip a trader's setups in conditions where it clearly
loses, and favour those where it clearly wins. Example: if Nora loses on quiet mornings,
she stops trading on quiet mornings.

- **Data:** "When setups win" (`src/services/conditionStats.ts`), per trader and market.
- **When:** once most rows there have 20+ setups.
- **Guardrails:**
  - Only act on a clear effect. A row whose losses could be chance (few setups, or a
    small gap from the trader's average) changes nothing.
  - Reuse the scoring table's pull toward no effect rather than a fixed cut-off.
  - Show skipped setups with their reason (a new `scanOutcome.ts` reason), so the owner
    can see what was filtered.
  - Recheck each filter as the 30-day window moves: a condition that stops losing
    stops being skipped.

## 2. Self-tuning traders (after condition filters)

The replay tries a few versions of each trader's settings on past data and switches to
the best one. Each trader's settings are a tuning object in `src/services/personaEngine.ts`
(the shapes are in `src/services/strategyEngine.ts`, e.g. `OpeningRangeTuning`,
`LateMomentumTuning`), so the candidates are small changes to those numbers:

- stop distance (`stopAtrMult`, `stopPriceFloorPct`)
- target size (`targetStopMult`)
- the entry bar (e.g. Nora's `minRelativeVolume`, her `entryWindowBars`)

**The danger** is settings that only suited the past by luck ("overfitting"). Guardrails:

- **Test on unseen days (walk-forward):** pick settings on the older part of the 30
  days, then accept them only if they also beat the current settings on the most
  recent days, which weren't used to pick them.
- **Few candidates:** a handful of versions per trader (e.g. current, one step either
  way on two settings), not a wide search. The more versions tried, the more likely one
  wins by luck.
- **Small steps:** move one step at a time, at most once a week per trader.
- **Enough data:** at least 30 setups for that trader in that market.
- **Kept on record:** store each change (old and new settings, the replay results that
  justified it, the date) on the server volume, and show it on the trader's row, with
  a way to put the old settings back.
- **Same exits:** replays still use the live exits, fees and spreads
  (`exitExpectancy.ts`, `labSimulation.ts`), exactly as the traders' records do.

## 3. More money for proven traders

Give traders with strong records a larger amount per trade, and weak ones less. Today
every trade in a market gets the same amount and risk (`marketLimits.ts`:
`amountPerTradeInr`, `riskPerTradeInr`).

- **Size by record:** scale the risk per trade by the trader's judged result in that
  market, e.g. between 0.5x and 1.5x of the owner's setting.
- **Owner's limits stay the ceiling:** never above the owner's maximum order value,
  exposure limit, trades at once, or the 2-per-sector rule.
- **Enough data:** only traders with 30+ setups in that market; everyone else stays
  at 1x.
- **Visible:** show the size multiplier on the trade proposal and in "Traders with
  your exits".

## 4. A full machine-learning model (not yet)

A model trained on every setup's features to predict wins. It needs far more varied
data than 30 days of live records (it would memorise that month's luck). The two-year
replay supplies it: it saves every replayed setup with its readings and its result under
each trailing stop (`history_setups/` on the server, 1 Oct). Train on the older part, and use the model only if it beats the scoring table on the latest 6 months,
which it never saw, then on 2 weeks of paper trading where it scores but decides nothing.
Look at the exits first (the two-year replay compares the trailing stops): a model can
only pick the least-bad setups if the exits cut wins short.
