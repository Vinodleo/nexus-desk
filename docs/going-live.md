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
- [ ] **A watchdog server for live trades' stops** (before raising the size; owner's call,
      Oct 2026). CoinDCX's INR markets take no stop orders, so if the server is down when a
      coin falls through a live trade's stop, nothing sells until it's back. The watchdog is a
      second, tiny Fly app in another region (about $2 a month, ~₹170): every minute it copies
      the open live trades and their stops from the main server and checks it's alive; if the
      main server has been silent for ~3 minutes, it watches CoinDCX's prices itself and sells
      at a stop, with a pop-up. It sends the same first exit `client_order_id` the main
      server would, so CoinDCX refuses whichever comes second: never two sales. When the main
      server is back it finds the sale at CoinDCX and closes the trade. Not a full second
      server (two copies of the state, and both could trade). Setup by the owner: one
      `fly launch`/`fly deploy` and its own `fly secrets set` of the CoinDCX keys; if the key
      is locked to an IP, add the watchdog's. (Free alternative, more setup: Google Cloud's
      always-free e2-micro, which also survives a whole-Fly outage.) Until then: the uptime
      alert, and a CoinDCX price alert at each live trade's stop (step 4).
- [ ] **Count the coins in a live desk's money** (found Oct 2026): in live mode the desk's
      money is only the rupee cash at CoinDCX (`effectiveEquity` in `src/App.tsx`), not the
      coins bought with it, so after each buy it looks smaller by what was bought. Coin
      breakout's size comes from the coin amount and risk per trade, so it isn't affected;
      the money shown is, and so is anything sized from it (the 5-minute traders' risk is
      capped at 0.3% of it). Count each coin held at today's price. (Fixed meanwhile: the
      rupee total now includes money held by open orders, as CoinDCX's docs define it.)
- [x] **Verify CoinDCX's API** (Oct 2026, from its docs, docs.coindcx.com):
      `orders/status` and `orders/cancel` take `client_order_id` (or `id`); the status
      reply's `total_quantity`, `remaining_quantity`, `avg_price` and statuses (`init`,
      `open`, `partially_filled` open; `filled`, `partially_cancelled`, `cancelled`,
      `rejected` done) are as the code reads them; signing (HMAC-SHA256 of the compact
      JSON body, `X-AUTH-APIKEY`, `X-AUTH-SIGNATURE`) matches. A reused
      `client_order_id` is refused, so each exit send now has its own. INR markets take
      no `stop_limit` (above). Fees: answered by the test order (4 Oct 2026, below).
- [x] **CoinDCX's real fees in the replays and paper trades** (Oct 2026): the test order's
      screens showed **0.5% of each order plus 18% GST on it, 0.59% a side, taken in
      rupees** (the full quantity bought arrives, and sells in full), and **1% TDS
      withheld from each sale**. The app had assumed 0.05% a side (CoinDCX's futures
      schedule): every coin replay and paper trade was too optimistic. Now 0.59% a side
      everywhere (`COIN_FEE_PER_SIDE`, `shared/tradeMath.ts`); TDS isn't counted as a cost
      (it's income tax paid in advance, reclaimed when filing), but it holds back 1% of
      each sale until then. 5-minute coin trades now can't pass the costs check at all
      (their stops are too close for a 1.18% round trip). The replays since 2017 and the
      slower two-year ones rerun with the real fee; coin breakout and the daily traders
      pause until they finish, then trade only if their new records clear the bar.

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

## 3½. A test order (₹200, any time, owner's call)

Settings → Connections → **Test live order** buys ₹200 of a coin at CoinDCX for real and,
when you tap **Sell it**, sells it, through the same checks and exit every live trade
takes (`server/liveTest.ts`). The desk stays on **Paper**, so nothing else trades live.
It answers the fee question (does CoinDCX take the buying fee in coins?) and shows the
fill prices and what the round trip cost. **Done 4 Oct 2026** (₹170 of BTC): the order
went through and sold in full; fees in rupees, 0.59% a side; ₹4.53 in all, of which
₹1.69 TDS (reclaimable). Run it again any time with the same steps.

- [ ] About **₹300** at CoinDCX (₹200, its fee, and room). With less it refuses before
      sending anything.
- [ ] CoinDCX API key set on the server (trading allowed, **withdrawals off**), from Cloud
      Shell: `fly secrets set COINDCX_API_KEY=… COINDCX_API_SECRET=… -a nexus-desk-vinodleo`.
- [ ] Live orders allowed, small caps, two coins to pick from:
      `fly secrets set LIVE_TRADING_ENABLED=true LIVE_ALLOWED_MARKETS=BTCINR,ETHINR LIVE_MAX_ORDER_NOTIONAL_INR=300 LIVE_MAX_DAILY_NOTIONAL_INR=1000 LIVE_MAX_DAILY_ORDERS=4 -a nexus-desk-vinodleo`
- [ ] Settings → Connections → Test live order → **Buy ₹200** → **Yes, buy**. Read the
      result (screenshot it for Claude; it has no secrets), then **Sell it**. If a coin's
      size is under CoinDCX's minimum, it says so before sending; pick the other coin.
- [ ] If the sale is refused because the fee came out of the coins, sell the coin on
      CoinDCX by hand, and tell Claude: exits then need to sell only what's held.
- [ ] Afterwards, live orders off again: `fly secrets unset LIVE_TRADING_ENABLED -a nexus-desk-vinodleo`.

## 4. The first live trade (watched together)

- [ ] Small funds in CoinDCX (₹10,000–20,000).
- [ ] The owner sets `LIVE_TRADING_ENABLED=true`, switches the desk to Live in Settings.
- [ ] On the first trade, check:
  - [ ] The buy filled near the expected price.
  - [ ] Settings → Server → CoinDCX check says **OK** within the hour (the fee comes out
        of rupees, so the full quantity is held: the test order showed it).
  - [ ] In the CoinDCX app, a price alert at the trade's stop: if the server is down when
        the price gets there, CoinDCX tells you, and you sell by hand (until the watchdog).
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
- Tax: crypto gains 30%; 1% TDS is withheld from every sale and reclaimed (or set
  against the tax) when filing. Keep CoinDCX's tax reports.
