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
- **"Paused" means paused.** A trader averaging under `MIN_EDGE_R` with the owner's exits doesn't trade.
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
  - Per-market limits: `marketLimits.ts`, the amount per trade and trades at once for each market.
- **Trader records ("Traders with your exits"):** `src/services/exitExpectancy.ts`.
  - It replays every trader's setups under the live exits, after fees and spreads.
  - Records are pooled across markets.
  - Stock setups count only in their entry hours (`takesEntriesAt` in `labSimulation.ts`).
- **When setups win:** `src/services/conditionStats.ts`, results grouped by market conditions.
- **Hosting and secrets:** `docs/hosting.md` and `.env.example`.

## Plans

- **Condition filters:** once "When setups win" has 2–3 days of data (most rows with 20+ setups),
  skip conditions that clearly lose and favour ones that win.
- **Watch the US traders' records:** check them after the session-hours fix. If losses are still well past −1R,
  look at IEX bid/ask spreads next.
- **Going live:** only when the owner asks, after "Traders with your exits" shows traders with positive records.
- **IBKR:** the owner is applying for an IBKR Pro account (no deposit yet). An integration may follow later.

## Gotchas

- Don't unregister the service worker anywhere. That broke Trade pop-ups before.
- Vitest can't load `virtual:pwa-register`. Only `src/services/registerApp.ts` (from `main.tsx`) imports it.
- Trades labelled "autopilot (server)" were opened by the server. Plain "autopilot" means the phone opened them.
