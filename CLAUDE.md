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
    and at most 2 open trades in one stock sector (`sectorOf`).
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
- **Daily coin trades (paper, owner's call, 3 Oct):** `server/scanner/dailyCoins.ts`. Once a day, 10 minutes after the
  00:00 UTC daily close (until 6 hours after), the server reads each coin's daily candles from Binance (today's coins plus
  `FIXED_COINS`, those CoinDCX lists) and takes the setups the two-year replay would take there (`latestSlowSetups`).
  They open through the server autopilot within the coin limits, priced at CoinDCX's ask with the stop and target scaled
  from Binance's chart, never live and without Gemini's review. A trader trades only if its two-year daily coin record
  with the owner's trailing stop averages `MIN_EDGE_R`+ over `MIN_TRADER_TRADES`+ setups (`dailyTraderGates`); each
  trades alone (no panel vote). Positions carry `timeframe: "1d"`: held up to 30 days and closed at that limit exactly
  (`holdingDecision`), trailed on the daily ATR, labelled "daily", and left out of the 5-minute traders' real record.
  The Lab's "Daily coin trades" card shows each day's check.
- **Machine-learning test (Lab):** `server/history/mlTest.ts` trains gradient-boosted trees (`src/services/setupModel.ts`)
  on the saved setups: the older months train, the next 3 tune, the latest 6 judge (never seen). A market passes only if
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
  since 3 Oct. US daily was only slightly positive and India lost at every speed: not traded slower.
- **Going live:** only when the owner asks, after "Traders with your exits" shows traders with positive records.
- **IBKR:** the owner is applying for an IBKR Pro account (no deposit yet). An integration may follow later.

## Gotchas

- Don't unregister the service worker anywhere. That broke Trade pop-ups before.
- Vitest can't load `virtual:pwa-register`. Only `src/services/registerApp.ts` (from `main.tsx`) imports it.
- Trades labelled "autopilot (server)" were opened by the server. Plain "autopilot" means the phone opened them.
