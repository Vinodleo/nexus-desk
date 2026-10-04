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
      leave it unprotected (`server/liveExecution.ts`). **But CoinDCX's INR markets take
      only market and limit orders** (its docs), so on the coins breakout trades there's
      no backup stop: the server skips it where CoinDCX's market list doesn't offer
      `stop_limit`. There, the server's own stop, Fly's automatic restarts and the
      uptime alert are the protection; breakout's stops are wide (2 ATR, judged on
      daily closes), so a short outage rarely matters.
- [x] **A live path for coin breakout** (Oct 2026): on a desk in live mode, coin breakout
      opens real CoinDCX orders through the server's live checks (`LIVE_TRADING_ENABLED`,
      `LIVE_ALLOWED_MARKETS`, the order caps), with its backup stop; the daily traders open
      nothing there (paper only, `LIVE_DAILY_NOTE`). US stocks stay paper.
- [x] **Daily off-site backups** (Oct 2026): the server's saved state, once a day, to Fly's
      object storage, 30 days kept; restore with `RESTORE_BACKUP` (docs/hosting.md).
      Still to do by the owner: set it up (`fly storage create`, step 3) and **try one
      restore** while on paper.
- [x] **A daily check against CoinDCX** (Oct 2026, `server/coinDcxCheck.ts`): the coins
      held there (open orders' share included) match the open live trades the app knows.
      Hourly while live trades are open, daily otherwise (then it just confirms the keys
      work). A pop-up, once a day, when a coin is **missing** (sold or moved outside the
      app), a little **short** (up to 1%: the buying fee taken in coins, so selling the
      whole quantity would be refused) or a failed exit's coins are **still held**. A
      mismatch is told only once seen twice, 5 minutes apart. Coins held beyond the
      live trades (your own) are only listed. Settings → Server → CoinDCX check.
- [x] **Verify CoinDCX's API** (Oct 2026, from its docs, docs.coindcx.com):
      `orders/status` and `orders/cancel` take `client_order_id` (or `id`); the status
      reply's `total_quantity`, `remaining_quantity`, `avg_price` and statuses (`init`,
      `open`, `partially_filled` open; `filled`, `partially_cancelled`, `cancelled`,
      `rejected` done) are as the code reads them; signing (HMAC-SHA256 of the compact
      JSON body, `X-AUTH-APIKEY`, `X-AUTH-SIGNATURE`) matches. A reused
      `client_order_id` is refused, so each exit send now has its own. INR markets take
      no `stop_limit` (above). **Still open:** whether buying fees come out of the coins
      received (then the coins held are a little under the quantity bought, and selling
      it all would be refused): check on the first watched trade (the CoinDCX check
      says so within the hour).

## 3. One-time setup (the owner, from Google Cloud Shell; never secrets in chat)

- [ ] **Backups on**: `fly storage create -a nexus-desk-vinodleo`; Settings → Server →
      Backups says On. Try one restore while on paper (docs/hosting.md).
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
  - [ ] CoinDCX's coin balance after the buy: is it the full quantity bought, or a
        little less (the fee taken in coins)? Closing must sell exactly what's held.
        Settings → Server → CoinDCX check says **OK** within the hour, or pops up
        "a little short" (then exits need to sell only what's held: tell Claude).
  - [ ] (Only if CoinDCX ever offers stop orders on INR markets: the backup stop shows
        in CoinDCX → open orders, and moves up as the stop trails.)
  - [ ] Closing from the app cancels the backup stop, then sells; the Book shows the
        trade with its fees.
- [ ] The first 20–30 live trades match paper (scorecard). Only then raise the most to
      lose per trade, in steps (₹500 → ₹1,000 → …).

## 5. US stocks live (later)

- [ ] IBKR Pro account funded; a broker integration built (Alpaca's paper account stays
      for paper). Until then US trades are paper only.

## Stop rules (any time)

- Kill switch (Settings) and tell Claude if: live results go **Behind the replay** over
  30+ trades, a **"Live exit failed"**, **"Backup stop refused"** or **"CoinDCX check"**
  pop-up comes, or the uptime alert fires while trades are open.
- Losing streaks are normal for breakout (it wins 1 in 3 or 4): don't stop on a streak
  alone, stop on the scorecard.
- Tax: crypto gains 30% plus 1% TDS; keep CoinDCX's tax reports.
