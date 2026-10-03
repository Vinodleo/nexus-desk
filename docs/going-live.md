# Going live: the checklist

Live trading stays off until the owner says so (`LIVE_TRADING_ENABLED` unset on the
server). This is what has to be true, built and checked first, in order. When the
owner says "going live", start here: tick what's done, build what isn't (one PR each).

Written October 2026, when paper trading began for the slower strategies (coin breakout
55/20 and the daily coin traders since 3–4 Oct, US breakout and US momentum since
early Oct).

## 1. Proof on paper (about 6 months: from April 2027)

- [ ] **Lab → Records → "Paper trades against the replay"**: coin breakout shows
      **In line** or **Ahead**, with **25+ closed trades**. (Its edge is big enough to tell
      from luck at about 25; the US strategies need about 100, two years or more.)
- [ ] No strategy that's going live shows **Behind the replay**.
- [ ] Stops that gapped past (the scorecard's "gapped past it") are rare: a few, not most.
- [ ] Decide which strategy goes live first. Expected: **coin breakout only**.
      The daily coin traders' edge is small (+0.07R); US stocks need a broker (step 5).

## 2. Builds needed before real money (ask for each; one PR each)

- [x] **Backup stops at CoinDCX** (Oct 2026): each live coin trade gets a stop-limit
      sell resting at CoinDCX, 0.5% under the server's stop, so a server outage can't
      leave it unprotected (`server/liveExecution.ts`).
- [ ] **A live path for coin breakout.** Today a desk in live mode gets **no** daily or
      breakout trades (`deskNote` in `server/scanner/dailyCoins.ts`, and `PAPER_HOOKS`
      refuses live entries): live mode would leave only the 5-minute traders, which are
      paused. Needed: let the strategy chosen in step 1 open live, the rest staying paper.
- [ ] **Daily off-site backups** of the server's data (`/data` on Fly: positions,
      live-order records, settings), with a tested restore.
- [ ] **A daily check against CoinDCX**: the coins held there match the open live
      trades the app knows; a pop-up on any mismatch.
- [ ] **Verify CoinDCX's API** where the code assumes (no docs could be reached from the
      build environment): `orders/status` and `orders/cancel` accepting
      `client_order_id`; `stop_limit` with `stop_price` and `price_per_unit` on INR
      markets; whether buying fees come out of the coins received (then the coins held
      are a little under the quantity bought, and selling it all would be refused).

## 3. One-time setup (the owner, from Google Cloud Shell; never secrets in chat)

- [ ] **Uptime alert**: a free UptimeRobot (or similar) check on
      `https://nexus-desk-vinodleo.fly.dev/api/health`, alerting your phone and email
      (docs/hosting.md). It answers 503 when the scanner has stopped.
- [ ] **CoinDCX API key**: trading allowed, **withdrawals not allowed**; restricted to the
      server's IP if CoinDCX offers it. Set with `fly secrets set COINDCX_API_KEY=…
      COINDCX_API_SECRET=…`.
- [ ] **Server caps** (`fly secrets set`, see `.env.example`):
  - `LIVE_ALLOWED_MARKETS`: the coins the live strategy trades. Today's list has 7
    (BTC, ETH, SOL, AVAX, NEAR, JUP, XRP); breakout trades this year's 20 biggest.
  - `LIVE_MAX_ORDER_NOTIONAL_INR` at least the coin amount per trade.
  - `LIVE_MAX_DAILY_NOTIONAL_INR` and `LIVE_MAX_DAILY_ORDERS`: small to start.
- [ ] **Settings in the app**: coins, most to lose per trade **₹500**; amount per trade small
      (₹5,000–10,000); breakout trades at once **2**.

## 4. The first live trade (watched together)

- [ ] Small funds in CoinDCX (₹10,000–20,000).
- [ ] The owner sets `LIVE_TRADING_ENABLED=true`, switches the desk to Live in Settings.
- [ ] On the first trade, check:
  - [ ] The buy filled near the expected price.
  - [ ] **CoinDCX → open orders shows the backup stop**: a stop-limit sell, the full
        quantity, just under the app's stop. A **"Backup stop refused"** pop-up means
        CoinDCX didn't take it: say so (the server still watches the stop).
  - [ ] As the stop trails up, the backup order moves up with it.
  - [ ] Closing from the app cancels the backup stop, then sells; the Book shows the
        trade with its fees.
- [ ] The first 20–30 live trades match paper (scorecard). Only then raise the most to
      lose per trade, in steps (₹500 → ₹1,000 → …).

## 5. US stocks live (later)

- [ ] IBKR Pro account funded; a broker integration built (Alpaca's paper account stays
      for paper). Until then US trades are paper only.

## Stop rules (any time)

- Kill switch (Settings) and tell Claude if: live results go **Behind the replay** over
  30+ trades, a **"Live exit failed"** or **"Backup stop refused"** pop-up comes, or the
  uptime alert fires while trades are open.
- Losing streaks are normal for breakout (it wins 1 in 3 or 4): don't stop on a streak
  alone, stop on the scorecard.
- Tax: crypto gains 30% plus 1% TDS; keep CoinDCX's tax reports.
