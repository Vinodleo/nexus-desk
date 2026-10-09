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
  - **Today:** the slower strategies as a deck of cards to swipe (`StrategyLineup`: each one trading or paused, its
    replay's average a trade and trades, each replayed year up or down, its rules), the other traders and the tests
    (`LabSummary`), the desk's day (`DeskDayCard`: a 24-hour dial in India time of the
    market sessions and the server's scheduled checks with their next times; the check times live in `src/shared/deskDay.ts`
    and the server reads them there), the daily coin check with its coin slots (`DailyCoinsCard`),
    the US breakout check (`UsBreakoutCard`), the funds' breakout check (`FundsBreakoutCard`) and the weekly US
    momentum check (`UsMomentumCard`).
  - **Records:** the scorecard first (`PaperScorecard`, `services/paperScorecard.ts`): coin breakout's, US breakout's,
    the funds' breakout's, US momentum's and the daily coin traders' real paper trades from the Book against their replays (R, share won, average win and loss,
    exits, stops that gapped; "in line", "behind" or "ahead" once 10+ trades, by two standard errors). Then every coin
    strategy side by side against `MIN_EDGE_R` (`StrategyRanking`), year by year (`YearByYear`), the classic strategies
    on stocks (`StocksLongCard`, US and India), and the replays' details.
  - **Tests:** the machine-learning tests (daily coins, breakout trades, 5-minute) and the coin check (`CoinCheckCard`).
  - **Tools:** the older hands-on training tools.
  A trade that opens with the app on screen (the server's, the phone's autopilot, or approved in the Queue) unfolds a
  ticket over it (`TradeTicket`): what was bought, the stop, why (the slower strategies) and on paper the free cash it
  took; several queue up.
  Book → Trades: the running total of closed trades as a line that draws itself (`MoneyLine`), a month of days tinted
  by what each made or lost, opening on this month with its total, the arrows or a swipe going to any month (tap a day
  for only its trades; `DayCalendar`, `BookCalendar.tsx`), and each row's result in R
  after fees (`resultR`) with a slim line of how it moved. Book → Breakdown (last 7 days, this month or all, `tradesIn`):
  where the money went (`MoneyWaterfall`, `moneyFlow`: won and lost before fees, the fees, what was kept; what coin
  fees took), each strategy's result either side of zero (`ByStrategy`, `strategyOf`), and the win rate on a half dial
  against the rate that breaks even (`WinGauge`), in `BookMoney.tsx`. Book → Risk opens on three rings (today's loss
  limit left, what every open stop hitting would take of it, the money in trades; `RiskGlance`), each open trade's loss
  at its stop (`IfStopsHit`, `allStops`, before fees) and "Hold to stop all trading" (held, like Close; Resume is a tap).
  Explanations and long lists fold away (`Fold`); chips, bars and year columns are in `labUi.tsx`. The cards read
  their routes through `labFeed.ts`: all tabs stay mounted and one request per route serves every card.
- **Server:** Express in `server.ts` and `server/`. It stays running on Fly with its state on a volume
  (`NEXUS_DATA_DIR`), so it keeps working with the app closed.
  - The scanner runs after every 5-minute candle close (`server/scanner/`), on Indian and US stocks in their hours.
    Coins aren't scanned on 5-minute candles (owner's call, 5 Oct: with CoinDCX's real fee none pass the costs check;
    `fiveMinuteCoinsScanned`, `_setFiveMinuteCoins` for the tests of that path): coins trade on the daily check, which
    keeps their typical spreads current from the quotes it reads (`recordSpread`). It still scans when no market is
    open, so the app (which scans by itself only while the server doesn't) stays out of it.
  - The server autopilot is in `server/scanner/autopilot.ts`.
  - The guardian (`server/guardian.ts`) manages stops and exits 24/7.
  - Live coin trades (`server/liveExecution.ts`): the server sends every exit itself (idempotent, retried). Each live
    long also has a backup stop resting at CoinDCX (a `stop_limit` sell `BACKSTOP_GAP` 0.5% under the guardian's stop,
    `reconcileExchangeStops` every 15 s): moved up as the stop trails (by 0.5%+, cancel then replace), cancelled before
    any exit (it holds the coins), and a fill there closes the trade in the guardian at CoinDCX's price
    (`setExchangeStopListener`). If CoinDCX refuses it, a pop-up says so once and the guardian watches the stop alone.
    CoinDCX's INR markets take only market and limit orders (its docs), so where its market list (`orderTypes`)
    doesn't offer `stop_limit` no backup stop is tried (`UNSUPPORTED`, no pop-up). Each exit send has its own
    `client_order_id` (`exitClientOrderId`): CoinDCX refuses a reused one, even a rejected order's.
  - The test live order (`server/liveTest.ts`, Settings → Connections → Test live order): one real ₹200 buy
    (`TEST_ORDER_INR`) and, on "Sell it", its sale, through `placeLiveEntry` and `requestLiveExit` with the desk left on
    Paper. Not in the guardian (no stop). It reads the balances around each order: where the fee came from
    (`feeFromCoins`), what it cost (`roundTripCost`: fees, TDS, price move). CoinDCX's balances can take seconds to
    show an order, so after answering the app it keeps reading them (`followUp`, every 3 s, `BALANCE_READS`) until
    both the coin and rupees moved, while the card looks again (`settling`). Refuses before sending with live orders
    off, too little at CoinDCX, one unsold, or the balances still being read.
  - The CoinDCX check (`server/coinDcxCheck.ts`): the coins held at CoinDCX (`fetchCoinBalances`, balance plus
    locked_balance) match the open live trades (`compareHoldings`): hourly while any are open, daily otherwise. A coin
    missing, a little short (up to `FEE_SHORT` 1%: the fee taken in coins) or a failed exit's coins still held pops up
    once a day, once seen on two checks 5 minutes apart; coins beyond the live trades are only listed. Trades opened
    in the last 5 minutes and ones being closed aren't compared. Settings → Server → CoinDCX check.
  - Web Push sends the trade pop-ups.
  - The weekly summary (`server/weeklySummary.ts`): a pop-up each Sunday at 10 am India time per desk, from the trades
    the server closed: the week's closed, won, still open and what they made, and each slower strategy's paper trades
    so far against its replay (`paperScore`, a strategy clearly behind named first). Sent late after a restart until
    Tuesday; nothing on an empty week; "on paper" dropped once a trade is live.
  - Daily backups (`server/backup.ts`): every top-level file in the data folder (not the rebuildable folders, not
    `angel_tokens.json`) as one gzipped JSON a day to an S3 bucket (Fly's Tigris, set up by `fly storage create`, which
    sets the `AWS_*`/`BUCKET_NAME` secrets itself; `server/s3.ts` signs requests with SigV4, no SDK), 30 days kept,
    shown in Settings → Server → Backups, a pop-up once a day if failing. `RESTORE_BACKUP=YYYY-MM-DD` restores a day at
    start-up (once, `.restored` marker; replaced files kept in `before-restore-…`) and restarts (docs/hosting.md).
- **Shared rules:** `src/shared/` and `src/services/`, used by both the app and the server.
  - Exit rules, trailing stops and trade maths. Coin fees are CoinDCX's INR spot ones, from the test order's
    screens (4 Oct): 0.5% of each order plus 18% GST, 0.59% a side in rupees (`COIN_FEE_PER_SIDE`,
    `COIN_ROUND_TRIP_FEE` 1.18%), so 5-minute coin setups never pass the costs check. 1% TDS on each sale isn't a
    cost (reclaimed when filing). Tests that follow 5-minute coin setups through later steps charge a cheaper 0.1%
    (`_setCoinRoundTripFee`). Kept trader records and the long replays measured under other coin costs aren't used
    (`COIN_COSTS_VERSION`, `DAILY_LONG_VERSION` 3, `SLOW_VERSION` 5).
    A stop "past break-even" (trailing floors, the stop after banking half, `stopLocksProfit`) clears the market's
    costs a round trip (`breakevenBuffer`: coins the round trip plus `COIN_SPREAD_ALLOWANCE`, 1.26%; Indian stocks
    0.3%; US 0.1%), and a stop moves there only once the price is past it (else trailing leaves it, banking moves it
    to entry): a stop at or past the price would sell at once.
  - Market sessions: `nse.ts`, `usMarket.ts`.
  - Per-market limits: `marketLimits.ts`, the amount per trade, risk per trade and trades at once for each market,
    and at most 2 open trades in one stock sector (`sectorOf`). Breakout 55/20 has slots of its own in coins and US
    stocks (`breakoutTrades`, 3 until chosen, none switches it off), and US momentum in US stocks (`momentumTrades`,
    0 to 3, 3 until chosen), and breakout on the funds in US stocks (`fundsTrades`, slot kind "funds" for a breakout
    trade on a fund, `isFundSymbol`, 3 until chosen): each kind counts only against its own (`SlotKind`, `slotKindOf`, `openInSlots`, `slotsFor`),
    every other trade only against trades at once, in the autopilot and the risk check alike, so the daily traders
    can't keep them out. Their scheduled checks open past the autopilot's hourly cap (their slots bound them) but
    still count toward it. Positions of these slower strategies carry `strategy` (`SlowStrategy` in `types.ts`).
  - Paper money (Settings → Trading, paper only): the paper balance starts again at a picked amount
    (`PAPER_MONEY_CHOICES`, `restartedPaperCapital`; the all-time P&L from zero, trades kept; the start in its own
    localStorage key, not the capital state Firebase copies). The daily loss limit is 2.5% of the money, at least ₹2,500
    (`dailyLossLimitFor`, on the phone and the server); amounts per trade go up to ₹2 lakh and risk to ₹10,000.
    A paper desk is a cash account (`src/shared/paperCash.ts`): open paper trades tie up what they cost and the fee
    paid to open them (`cashTiedUp`, `moneyInTrades`, `entryFee` in `tradeMath.ts`: CoinDCX's 0.59%, Alpaca's
    regulatory fees, Angel One's charges on the opening order), and the autopilot, on the server and the phone, defers
    a trade whose cost and opening fee are more than the free cash left (`freeCash`, `AutopilotBook.freeCash`, "not
    enough free cash"); live desks aren't held to it (CoinDCX's balance is). The Floor's
    paper equity includes the open trades' profit; under it a ring shows the free cash against what's in trades (`MoneyRing`).
    Breakout and momentum trades (no target) sit on a line in R (`riskLadder`), every trade shows where it is in R, and
    tapping one folds its numbers open.
  - Three 5-minute trades lost in a row stop autopilot until the owner looks (the app's kill switch, the server's
    pause; `lossStreak`, `LOSS_STREAK_LIMIT`). The slower strategies' and daily trades neither count nor break the run
    (owner's call, 8 Oct, `countsTowardStreak`): breakout and momentum win about one trade in three or four by design.
- **Tax report (Book → Breakdown, owner's ask):** `src/services/taxReport.ts`, `TaxReportCard`. An Indian financial year's
  closed trades (1 April to 31 March, India time), live and paper apart (`isLiveOrder` on closed trades; only live are
  taxed): coins as crypto (30% plus cess on each winner's gain before fees, losses offset nothing, 1% TDS on each sale),
  US stocks short- or long-term (over 24 months) after fees, Indian intraday net. A CSV for the CA (`taxReportCsv`).
  The rules as we understand them; the CA decides.
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
  `dailyLongRecords`, and `dailyLongClassic` for breakout) decide which traders take daily paper trades (owner's call, 4 Oct:
  nine years over two). A run of an older `DAILY_LONG_VERSION` decides nothing, even while it waits to rerun (shown with a
  note, `stale`); a due run blocked by other background work looks again every 15 minutes (`nextDailyLongCheckMs`).
- **Stocks on daily candles since 2016 (Lab):** `server/history/stocksLong.ts` runs the classic strategies on US and
  Indian stocks' daily candles: US from Alpaca (all exchanges' trades where the plan allows, else IEX; adjusted for splits
  and dividends, `fetchUsDailyBars`), India from Angel One (`fetchNseDaily`, unadjusted, so splits and bonus issues are found
  and adjusted, `adjustForSplits`). Each year trades only its 20 biggest stocks on 1 January (`STOCK_COHORTS`, from memory,
  nothing before 2016; a year of warm-up from 2015). Each market's index fund (`MARKET_FUND`: SPY, NIFTYBEES) is the
  200-day guard in place of Bitcoin; momentum rebalances at each week's last session (`stockWeekClose`). Costs: Alpaca's
  fees and a spread; for India, delivery charges (`stockCost`). Results by quarter per market (`stocks_long.json`), kept
  on show while it reruns. Monthly, at `CPU_SHARE`, never alongside the other background work; Indian downloads wait for
  NSE to close. It decides nothing: stocks paper-trade a strategy only if it clearly beats its costs and the owner says so.
  A third market, the funds (owner's ask): 16 US-listed funds across kinds of assets (`FUNDS`: gold, silver, gold miners,
  US government, inflation-linked, company and high-yield bonds, commodities, oil, the dollar, property, shares outside
  the US, the Nasdaq 100, small companies), the same every year, with no share-market guard (`GUARDED`: gold and bonds
  often rise when shares fall), replayed between US stocks and India; a finished run without them replays just them
  (`stocksLongMissing`). The Lab's stocks card has a Funds tab. Breakout paper-trades them (below); the rest trade nothing.
  The fund list is shared (`src/shared/funds.ts`).
- **Daily coin trades (paper, owner's call, 3 Oct; switched off 5 Oct):** `server/scanner/dailyCoins.ts`. **The daily
  traders are switched off** (owner's call, 5 Oct, `dailyTradersSwitchedOff`): with CoinDCX's real fee they lost together
  since 2018 (−0.05R, 1 of 9 years up), and the one still clearing the bar alone is likely the best of seven by luck. Their
  setups are still found and shown, paused with the reason (`DAILY_TRADERS_OFF_NOTE`); their records still replay; trades
  they had open run to their exits. The daily check trades breakout 55/20 alone. What follows is how they'd trade. Once a day, 10 minutes after the
  00:00 UTC daily close (until 6 hours after), the server reads each coin's daily candles from Binance (today's coins plus
  `FIXED_COINS`, those CoinDCX lists) and takes the setups the two-year replay would take there (`latestSlowSetups`).
  They open through the server autopilot within the coin limits, priced at CoinDCX's ask with the stop and target scaled
  from Binance's chart, never live (a live desk gets none) and without Gemini's review. A trader trades only if its daily coin record with the
  owner's trailing stop averages `MIN_EDGE_R`+ over `MIN_TRADER_TRADES`+ setups (`dailyTraderGates`): the record since
  2017 once that replay has finished, until then the two-year one's. Each trades alone (no panel vote). Positions carry `timeframe: "1d"`: held up to 30 days and closed at that limit exactly
  (`holdingDecision`), trailed on the daily ATR, labelled "daily", and left out of the 5-minute traders' real record.
  The Lab's "Daily coin trades" card shows each day's check.
- **Breakout 55/20 trades (paper, owner's call, 4 Oct):** in the same daily check, on this year's biggest coins
  (`cohortFor`): a close above the 55-day high buys at CoinDCX's ask, the stop 2 ATR below (`breakoutEntryAt`, shared
  with the replay); a close below the 20-day low sells at the bid (`breakoutExitAt`, `closeServerPosition`), even with
  autopilot off. No target, no trailing stop (`trailProfile` "fixed"), nothing banked at +1R, one trade per coin at a
  time, held up to a year (`BREAKOUT_HOLD_MINUTES`). The coin amount and risk per trade, on breakout's own coin slots
  (owner's call). On a desk in live mode it's the one daily-check strategy that trades live: real CoinDCX orders through
  the server's live checks (`placeLiveEntry`: `LIVE_TRADING_ENABLED`, `LIVE_ALLOWED_MARKETS`, caps), with its backup stop;
  the daily traders open nothing there (`LIVE_DAILY_NOTE`), and US checks stay paper. It trades only
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
- **Funds breakout 55/20 trades (paper, owner's call, 5 Oct):** the same check as US breakout, run a second time right
  after it (`runFundsBreakout`, `breakoutFunds`, state `funds_breakout.json`, `/api/funds-breakout`) on the 16 funds, the
  same every year. Positions carry `strategy: "breakout"` (all breakout behaviour: held overnight up to a year, sold
  below the 20-day low by its own check, fixed stop), on the funds' own US slots (`fundsTrades`), within the US amount and
  risk per trade, never live. Each check sees only its own held trades (`mine`: a fund's trade is the funds' check's). It
  trades only while the funds' breakout record since 2016 in the stocks' replay clears the bar (`stocksLongClassic("funds")`;
  +0.54R over 443 trades, 9 of 11 years up, +0.50R in 2022 when coins and US stocks lost). Scored apart (`fundsBreakout`)
  in the Lab's scorecard and the Sunday summary.
- **US momentum, top 3 (paper, owner's call):** `server/scanner/usMomentum.ts`. On each week's last US session
  (`weekLastSession`, from Alpaca's market calendar `fetchUsSessions`; Friday without it) at 3:45 pm New York, right
  after US breakout's and the funds' checks (one timer runs them in turn, `startUsChecks`, so they see each other's trades): this year's
  20 biggest US stocks ranked by their rise over 90 sessions (`momentumRise`, `momentumTop`, shared with the replay),
  the top 3 that rose are the week's picks while SPY is above its 200-day average (`fundUp`), none when it isn't. A
  held momentum trade no longer picked is sold at the bid (even with autopilot off); one still picked is kept; a pick
  not held is bought at the ask, the stop 3 ATR below (`momentumEntryAt`, `momentumSetup`), no target, no trailing,
  nothing banked, held overnight up to a year. One trade per stock across strategies and the sector limit still
  apply. It trades only while the stocks' replay's US momentum record since 2016 averages `MIN_EDGE_R`+ over
  `MIN_TRADER_TRADES`+ trades (`momentumGate`, `classicGate`). Positions carry `strategy: "momentum"`, labelled
  "momentum". Without prices or SPY's candles it tries again each minute until 3:50. State in `us_momentum.json`.
- **Machine-learning test (Lab):** `server/history/mlTest.ts` trains gradient-boosted trees (`src/services/setupModel.ts`)
  on the saved setups: the older months train, the next 3 tune, the latest 6 judge (never seen). It runs separately on
  the daily coin setups since 2017 (`MlSource` "daily": a year to tune, the latest year to judge, `ml_test_daily.json`). A market passes only if
  the picks, one at a time, average `MIN_EDGE_R`+ and clearly above zero. It runs after each replay, rests like it,
  sizes what it loads to the server's free memory and stops before 450 MB. Its verdict (`ml_test.json`) decides nothing live.
  A third test runs on breakout 55/20's replayed trades (`MlSource` "breakout", `src/services/breakoutModel.ts`): the
  coins' since 2018 and US stocks' since 2016, each saved with its readings at entry by those replays' classic step
  (`breakoutSetups`, `breakout_setups_coins.json`, `breakout_setups_us.json`; trades still open left out). Too few for
  the split above, so it's judged year by year (`walkForward`): each year from the fifth is judged by a model trained on
  the years before but the last, which sets the cut (the middle of its predictions); the model's picks are its more
  promising half. It passes only if the trades it would skip clearly lost (`highR` below zero) and its picks are
  `MIN_EDGE_R`+ ahead of every trade (`ml_test_breakout.json`). Momentum's (top 3) replayed trades are tested the same
  way alongside, on the same readings (`momentumSetups`, `momentum_setups_coins.json`, `momentum_setups_us.json`;
  verdict in the same file's `momentum`, coins marked "not traded" in the Lab). The funds' (gold, bonds and the rest)
  are tested the same way (`BreakoutMarket` "funds", `*_setups_funds.json`, marked "not traded"). Decides nothing live.
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
  trader losing about its costs. (The coin figures below were measured at 0.05% a side; CoinDCX's real 0.59% came in
  on 4 Oct, and the replays rerun with it: their new records decide.) Step 1: the same traders on 1-hour and 1-day candles (the Lab's timeframe switch).
  Step 2: strategies with long records (trend following, momentum), tested on the kept hourly candles. Paper first.
  Done so far: coins on daily candles passed the coin check (+0.12R a trade on the fixed list) and paper-trade daily
  since 3 Oct. US daily was only slightly positive and India lost at every speed: not traded slower. Since 2017 the
  daily traders averaged +0.07R (7 of 9 years positive, 2022 about even). The machine-learning test on daily setups
  didn't pass (its picks +0.05R against +0.14R for every setup, latest year): no filter. Step 2 (owner's call, 4 Oct):
  the classic strategies in the Lab, next to the traders, year by year; paper only if they clearly beat them.
  Since 2018 breakout 55/20 averaged +0.98R over 476 trades (6 of 9 years positive): it paper-trades alongside the
  daily traders since 4 Oct (owner's call). Moving averages 50/200 (+1.13R, mostly 2020) and momentum (+0.17R) aren't traded.
  With CoinDCX's real fee (rerun 5 Oct): breakout +0.87R (6 of 9 years), moving averages +1.07R, momentum +0.11R, the daily
  traders together −0.05R (1 of 9 years): coins trade breakout alone, the daily traders switched off (owner's call, 5 Oct).
  Stocks (owner's call): US and Indian stocks stay paused on paper (their traders' records decide); the classic strategies
  are tested on their daily candles since 2016 in the Lab, and trade only if one clearly beats its costs. US since 2016:
  breakout +0.39R over 554 trades (8 of 11 years up), momentum +0.26R (9 of 11), moving averages +0.32R (5 of 11): US
  breakout and US momentum paper-trade (owner's call), each on its own slots. India: breakout +0.23R but 5 of 11 years and mostly 2020; not traded.
- **Funds moving averages 50/200 (later, owner's call, 5 Oct):** once funds breakout has 2–3 months on paper and behaves
  like its replay (the Lab's scorecard), add 50/200 on the funds as a second, slower strategy: 2 slots of its own in the
  US limits, no share-market guard (as in the funds' replay), checked with the other US checks, paper only, gated on the
  funds' 50/200 record since 2016 (`stocksLongClassic("funds")`, `maTrend`). Its replay: +1.19R a trade over 112 trades
  (8 of 11 years up, all of 2023–26; −1.03R 2016, −0.85R 2017, −1.01R 2022), but only about 10 trades a year, so about
  12R a year against funds breakout's 22R, and a few big runs (gold's) carry it. It competes with funds breakout for the
  same funds (one trade per fund). Not to be traded: coins' 50/200 (+1.07R, mostly 2020, overlaps coin breakout) and
  US stocks' (+0.33R, 5 of 11 years up).
- **Going live:** only when the owner asks. The checklist is `docs/going-live.md` (proof on paper, setup, the
  watched first trade). Coin breakout's live path, backups and the daily CoinDCX check are built.
- **IBKR:** the owner is applying for an IBKR Pro account (no deposit yet). An integration may follow later.

## Gotchas

- Don't unregister the service worker anywhere. That broke Trade pop-ups before.
- Vitest can't load `virtual:pwa-register`. Only `src/services/registerApp.ts` (from `main.tsx`) imports it.
- Trades labelled "autopilot (server)" were opened by the server. Plain "autopilot" means the phone opened them.
- The app's push of its open trades (`useGuardianSync`) tells which ones left its book in the last week (`closedIds`,
  `noteGone`, kept per device): only those leave the guardian, which remembers them two weeks (`appClosedIds`, on
  disk) and refuses them from another device's older book. A trade missing from a push stays guarded, and each
  catch-up poll takes up any trade the guardian holds that the book lacks (`adoptGuardianPositions`), so two devices
  agree. An app from before `closedIds` still has a missing trade taken as closed. The app pushes nothing until the
  guardian has answered once, so an empty book (a new install, cleared storage) takes up the guardian's trades first.
