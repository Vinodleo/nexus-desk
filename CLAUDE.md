# Nexus Desk

A private trading desk (installable PWA) for one owner. It scans three markets, proposes trades,
and opens them on an autopilot within the owner's limits. It is **paper trading today**.

- **Coins:** CoinDCX INR spot, 24/7, long only.
- **Indian stocks:** Nifty 50 on NSE via Angel One. Intraday: entries 9:15–3:00 IST, closed by 3:20.
- **US stocks:** Alpaca paper account, free IEX feed, prices converted to rupees at the day's USD/INR rate.
  Long only. Entries 9:30–3:30 New York, closed at 3:50. Regular-session candles only.

## Standing rules (from the owner; don't change without asking)

- **Live trading stays off until the owner says so.** `LIVE_TRADING_ENABLED` stays unset on the server.
  The owner will say before going live (small funds first, then a watched first trade).
- **Never ask for or accept secrets in chat or screenshots** (API keys, PINs, TOTP secrets, tokens).
  The owner sets them on Fly (app `nexus-desk-vinodleo`) from Google Cloud Shell with `fly secrets set`.
- **One change per PR,** from the branch named in the session. Open the PR when the change is ready:
  that's the owner's workflow. They merge, Fly deploys, and they tap Settings → Version → Check for updates.
- **"Paused" means paused.** A trader averaging under `MIN_EDGE_R` with the owner's exits doesn't trade,
  nor does one with fewer than `MIN_TRADER_TRADES` (10) replayed setups in that market (owner's call, 28 Sept).
  The autopilot opens only trades that pass the server's checks. Trades the phone's own scan finds wait for the owner.
- **Before pushing:** `npm run lint` (tsc), `npm test` (vitest) and `npm run build` must pass.
  Add a test for every fix, and check it fails without the fix.
- The owner reads replies on a phone. Explain in plain words, briefly, and lead with the answer.

## How it fits together

- **App:** React 19 + Vite + Tailwind v4 in `src/`. Screens are in `src/components/ledger/`.
  Colours are tokens in `src/index.css`. Themes are Ivory (default), Graphite (dark) and Blush (pink),
  set per device (`src/services/theme.ts`). Use the tokens, never fixed colours.
  The Lab (`LedgerLab.tsx`) has four tabs, the last one picked remembered per device:
  - **Today:** what's trading and why (`LabSummary`), the daily coin check with its coin slots (`DailyCoinsCard`), and
    the US breakout check (`UsBreakoutCard`).
  - **Records:** the scorecard first (`PaperScorecard`, `services/paperScorecard.ts`): coin breakout's, US breakout's and
    the daily coin traders' real paper trades from the Book against their replays (R, share won, average win and loss,
    exits, stops that gapped; "in line", "behind" or "ahead" once 10+ trades, by two standard errors). Then every coin
    strategy side by side against `MIN_EDGE_R` (`StrategyRanking`), year by year (`YearByYear`), the classic strategies
    on stocks (`StocksLongCard`, US and India), and the replays' details.
  - **Tests:** the machine-learning test and the coin check (`CoinCheckCard`).
  - **Tools:** the older hands-on training tools.
  Explanations and long lists fold away (`Fold`); chips, bars and year columns are in `labUi.tsx`. The cards read
  their routes through `labFeed.ts`: all tabs stay mounted and one request per route serves every card.
- **Server:** Express in `server.ts` and `server/`. It stays running on Fly with its state on a volume
  (`NEXUS_DATA_DIR`), so it keeps working with the app closed.
  - The scanner runs after every 5-minute candle close (`server/scanner/`).
  - The server autopilot is in `server/scanner/autopilot.ts`.
  - The guardian (`server/guardian.ts`) manages stops and exits 24/7.
  - Web Push sends the trade pop-ups.
- **Shared rules:** `src/shared/` and `src/services/`, used by both the app and the server.
  - Exit rules, trailing stops and trade maths.
  - Market sessions: `nse.ts`, `usMarket.ts`.
  - Per-market limits: `marketLimits.ts`, the amount per trade, risk per trade and trades at once for each market,
    and at most 2 open trades in one stock sector (`sectorOf`). Breakout 55/20 has slots of its own in coins and US
    stocks (`breakoutTrades`, 3 until chosen, none switches it off): breakout trades count only against them and every
    other trade only against trades at once (`openInSlots`, `slotsFor`), in the autopilot and the risk check alike, so
    the daily traders can't keep breakout out.
- **Trader records ("Traders with your exits"):** `src/services/exitExpectancy.ts`.
  - It replays every trader's setups under the live exits, after fees and spreads.
  - One trade at a time per trader and market; the server keeps 30 days of trades (`server/scanner/traderRecords.ts`).
  - Records are pooled across markets.
  - The card sets each trader's real paper trades against the replay, per market (`realByTrader`, `replayVsReal`).
  - Stock setups count only in their entry hours (`takesEntriesAt` in `labSimulation.ts`).
- **Traders over two years (Lab):** `server/history/` downloads two years of 5-minute candles (coins from Binance,
  US from Alpaca, Nifty from Angel One outside NSE hours) and replays every trader under all four trailing stops
  (`src/services/historyReplay.ts`). It keeps the results (`history_results.json`) and every setup with its readings
  and results under each trailing stop (`history_setups/`, a gzipped CSV per market, capped at 300 MB): the data for
  machine learning. The 5-minute candles aren't kept; hourly ones are (`history_candles_1h/`), for slower strategies.
  Each market is also replayed on 1-hour and 1-day candles (`replayTimeframe`): stops sized on them, held up to 5 or 30
  days, overnight included (Indian stocks as delivery trades, `nseDeliveryRoundTripRate`). Volatility limits tuned on
  5-minute candles scale with the candle (`volatilityScale`). Bumping `SLOW_VERSION` redoes only the slower replays,
  from the kept hourly candles, without downloading again. The coins replayed are today's most active plus a fixed
  list, the 20 biggest on 1 Oct 2024 (`FIXED_COINS`), and each market's slower results are kept on their own (`slowTotals`):
  the Lab's coin check compares the two, in case today's picks flatter the traders. It runs weekly in the background
  at about 3% of a core (`CPU_SHARE`): Fly's shared CPU guarantees only 6.25%, and draining its burst allowance slows the scanner.
- **Coins on daily candles since 2017 (Lab):** `server/history/dailyLong.ts` replays the traders' daily coin trades over
  every year Binance has (daily candles from its API, `fetchCoinDailySince`; delisted pairs from its monthly zip archive;
  renamed coins via `DAILY_PAIRS`), to see whether they last through long falls (2018, 2022). Each year trades only its
  20 biggest coins on 1 January (`COIN_COHORTS`, from memory of the rankings; later years use the last list, and nothing
  trades before 2018: that list was 2017's winners), so today's
  winners aren't replayed in years they were small. Same exits, fees and spreads as the two-year daily replay; results by
  quarter (`daily_long.json`), shown by year. Every setup in a coin's list years is saved with its readings (Bitcoin's last
  30 days as the market's) and results (`daily_long_setups/`, `replayTimeframe`'s `onSetup`), for the machine-learning test.
  Each coin's daily candles are kept (`daily_long_candles/`), and at the end the classic strategies of step 2 run on them
  (`src/services/classicStrategies.ts`: breakout 55/20, moving averages 50/200 with Bitcoin's 200-day as a guard, momentum
  top 3 weekly), on the same coins and years, costs included, results in R by quarter (`classic`). Bumping
  `CLASSIC_VERSION` redoes only them, from the kept candles, leaving the traders' results alone. Monthly, at `CPU_SHARE`, never alongside the two-year replay or the
  machine-learning test (`waitForOtherWork`, `backgroundWorkBusy`). Its records (the last finished run's while it reruns,
  `dailyLongRecords`) decide which traders take daily paper trades (owner's call, 4 Oct: nine years over two).
- **Stocks on daily candles since 2016 (Lab):** `server/history/stocksLong.ts` runs the classic strategies on US and
  Indian stocks' daily candles: US from Alpaca (all exchanges' trades where the plan allows, else IEX; adjusted for splits
  and dividends, `fetchUsDailyBars`), India from Angel One (`fetchNseDaily`, unadjusted, so splits and bonus issues are found
  and adjusted, `adjustForSplits`). Each year trades only its 20 biggest stocks on 1 January (`STOCK_COHORTS`, from memory,
  nothing before 2016; a year of warm-up from 2015). Each market's index fund (`MARKET_FUND`: SPY, NIFTYBEES) is the
  200-day guard in place of Bitcoin; momentum rebalances at each week's last session (`stockWeekClose`). Costs: Alpaca's
  fees and a spread; for India, delivery charges (`stockCost`). Results by quarter per market (`stocks_long.json`), kept
  on show while it reruns. Monthly, at `CPU_SHARE`, never alongside the other background work; Indian downloads wait for
  NSE to close. It decides nothing: stocks paper-trade a strategy only if it clearly beats its costs and the owner says so.
- **Daily coin trades (paper, owner's call, 3 Oct):** `server/scanner/dailyCoins.ts`. Once a day, 10 minutes after the
  00:00 UTC daily close (until 6 hours after), the server reads each coin's daily candles from Binance (today's coins plus
  `FIXED_COINS`, those CoinDCX lists) and takes the setups the two-year replay would take there (`latestSlowSetups`).
  They open through the server autopilot within the coin limits, priced at CoinDCX's ask with the stop and target scaled
  from Binance's chart, never live and without Gemini's review. A trader trades only if its daily coin record with the
  owner's trailing stop averages `MIN_EDGE_R`+ over `MIN_TRADER_TRADES`+ setups (`dailyTraderGates`): the record since
  2017 once that replay has finished, until then the two-year one's. Each trades alone (no panel vote). Positions carry `timeframe: "1d"`: held up to 30 days and closed at that limit exactly
  (`holdingDecision`), trailed on the daily ATR, labelled "daily", and left out of the 5-minute traders' real record.
  The Lab's "Daily coin trades" card shows each day's check.
- **Breakout 55/20 trades (paper, owner's call, 4 Oct):** in the same daily check, on this year's biggest coins
  (`cohortFor`): a close above the 55-day high buys at CoinDCX's ask, the stop 2 ATR below (`breakoutEntryAt`, shared
  with the replay); a close below the 20-day low sells at the bid (`breakoutExitAt`, `closeServerPosition`), even with
  autopilot off. No target, no trailing stop (`trailProfile` "fixed"), nothing banked at +1R, one trade per coin at a
  time, held up to a year (`BREAKOUT_HOLD_MINUTES`). The coin amount and risk per trade, on breakout's own coin slots
  (owner's call). It trades only
  while its record since 2018 (the long replay's `classic`) averages `MIN_EDGE_R`+ over `MIN_TRADER_TRADES`+ trades
  (`breakoutGate`). Positions carry `strategy: "breakout"`, labelled "breakout".
- **US breakout 55/20 trades (paper, owner's call):** `server/scanner/usBreakout.ts`. Each US weekday at 3:45 pm New
  York (until the 3:50 close of intraday trades), on this year's 20 biggest US stocks (`stockCohortFor("us")`): completed
  daily candles from Alpaca plus today so far at the snapshot price (`withToday`), in rupees at the day's rate. A price
  above the 55-day high buys at the ask, the stop 2 ATR below; a held one below its 20-day low sells at the bid (even
  with autopilot off). Same rules as the coins' breakout (`breakoutSetup`, `dailyProposal` sized to the US limits), one
  trade per stock, never live. Breakout trades skip the stock markets' end-of-day close (`holdingDecision`): held
  overnight, up to a year. US stocks trade in fractions of a share (`ruleFor`, `US_FRACTION`); any US stock is known,
  share classes too ("BRK.B.US"). It trades only while the stocks' replay's US breakout record since 2016 averages
  `MIN_EDGE_R`+ over `MIN_TRADER_TRADES`+ trades (`stocksLongClassic`). If Alpaca's prices fail, it tries again each minute until 3:50.
- **Machine-learning test (Lab):** `server/history/mlTest.ts` trains gradient-boosted trees (`src/services/setupModel.ts`)
  on the saved setups: the older months train, the next 3 tune, the latest 6 judge (never seen). It runs separately on
  the daily coin setups since 2017 (`MlSource` "daily": a year to tune, the latest year to judge, `ml_test_daily.json`). A market passes only if
  the picks, one at a time, average `MIN_EDGE_R`+ and clearly above zero. It runs after each replay, rests like it,
  sizes what it loads to the server's free memory and stops before 450 MB. Its verdict (`ml_test.json`) decides nothing live.
- **When setups win:** `src/services/conditionStats.ts`, results grouped by market conditions.
  - It, the win-chance calibration and the trade memory count each trader's move once
    (`oneShadowAtATime` in `shadowTracker.ts`), not once per candle a setup stayed valid.
  - The confidence score's "what similar setups did" comes from the scoring table (`conditionModel.ts`):
    each trader in each market plus those conditions, thin rows pulled toward no effect.
- **Hosting and secrets:** `docs/hosting.md` and `.env.example`.

## Plans

- **Condition filters:** once "When setups win" has 2–3 days of data (most rows with 20+ setups),
  skip conditions that clearly lose and favour ones that win.
- **Making the traders learn** (details and guardrails in `docs/learning-plan.md`). The owner is gathering
  3–4 weeks of data first; build only when asked, in this order, one PR each:
  1. Condition filters (above).
  2. Self-tuning traders: the replay tries a few small changes to each trader's settings and switches
     only if they also win on recent days they weren't picked from.
  3. More money for proven traders: size each trade by the trader's record, within the owner's limits.
- **Watch the US traders' records:** check them after the session-hours fix. If losses are still well past −1R,
  look at IEX bid/ask spreads next.
- **Two new traders (added 28 Sept):** Nora Opening Range (US and Nifty stocks trading 2x their usual
  opening volume) and Ravi Late-Day Momentum (SPY, QQQ, IWM). They trade only once their records are positive over 10+ setups.
  Check "Traders with your exits" after a week or two; if either stays negative, remove it.
- **Trading slower (owner's call, 2 Oct):** two years of replays and the machine-learning test showed every 5-minute
  trader losing about its costs. Step 1: the same traders on 1-hour and 1-day candles (the Lab's timeframe switch).
  Step 2: strategies with long records (trend following, momentum), tested on the kept hourly candles. Paper first.
  Done so far: coins on daily candles passed the coin check (+0.12R a trade on the fixed list) and paper-trade daily
  since 3 Oct. US daily was only slightly positive and India lost at every speed: not traded slower. Since 2017 the
  daily traders averaged +0.07R (7 of 9 years positive, 2022 about even). The machine-learning test on daily setups
  didn't pass (its picks +0.05R against +0.14R for every setup, latest year): no filter. Step 2 (owner's call, 4 Oct):
  the classic strategies in the Lab, next to the traders, year by year; paper only if they clearly beat them.
  Since 2018 breakout 55/20 averaged +0.98R over 476 trades (6 of 9 years positive): it paper-trades alongside the
  daily traders since 4 Oct (owner's call). Moving averages 50/200 (+1.13R, mostly 2020) and momentum (+0.17R) aren't traded.
  Stocks (owner's call): US and Indian stocks stay paused on paper (their traders' records decide); the classic strategies
  are tested on their daily candles since 2016 in the Lab, and trade only if one clearly beats its costs. US since 2016:
  breakout +0.39R over 554 trades (8 of 11 years up), momentum +0.26R (9 of 11), moving averages +0.32R (5 of 11): US
  breakout paper-trades (owner's call). India: breakout +0.23R but 5 of 11 years and mostly 2020; not traded.
- **Going live:** only when the owner asks, after "Traders with your exits" shows traders with positive records.
- **IBKR:** the owner is applying for an IBKR Pro account (no deposit yet). An integration may follow later.

## Gotchas

- Don't unregister the service worker anywhere. That broke Trade pop-ups before.
- Vitest can't load `virtual:pwa-register`. Only `src/services/registerApp.ts` (from `main.tsx`) imports it.
- Trades labelled "autopilot (server)" were opened by the server. Plain "autopilot" means the phone opened them.
