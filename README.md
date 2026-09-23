# Nexus Desk

A self-learning, multi-agent trading terminal (React + Vite PWA) with an Express
backend. It paper-trades by default and can optionally route live orders to
CoinDCX. It streams live crypto prices from CoinDCX and Indian equity prices
from Zerodha Kite.

## Architecture

- **Frontend (`src/`)**: React 19 + Tailwind. It holds the strategy engine,
  a persona panel that votes on trades, the risk engine, backtesting and
  walk-forward validation, a TensorFlow.js model that learns from trade
  results, and Firebase Auth and Firestore persistence.
- **Backend (`server.ts`, `server/`)**: Express. It:
  - relays CoinDCX prices over WebSocket and runs the Zerodha Kite login and ticker
  - signs CoinDCX orders with HMAC
  - runs a 24/7 position guardian (stop-loss, take-profit, trailing stops,
    expiry), saved to `data/`
  - calls Gemini as the market, supervisor and autopsy agents, with rule-based
    fallbacks when the AI call fails

## Security model

- **Authentication.** Every `/api` route except `/api/health` requires a
  Firebase ID token (`Authorization: Bearer …`) for a verified email listed in
  `ALLOWED_EMAILS`. WebSocket clients must send
  `{"type":"AUTH","token":"…"}` within 10 s or they are disconnected.
  `src/services/apiClient.ts` handles both for you. If `ALLOWED_EMAILS` is
  empty, every request is rejected.
- **Exchange keys stay on the server.** CoinDCX and Zerodha keys are read only
  from server env vars. They are never accepted from, stored in, or returned to
  the browser. The Zerodha access token also stays on the server.
- **Live-order limits** (`server/liveOrderGuard.ts`). A live order is sent
  only when:
  - the client explicitly asks for it (`isPaperTrade: false` and
    `confirmLiveOrder: true`)
  - `LIVE_TRADING_ENABLED=true`
  - the market is on the allow-list
  - the price is within `LIVE_MAX_PRICE_DEVIATION_PCT` of the server's own last
    price
  - the order is within the per-order notional cap and the daily notional and
    order-count caps

  An order that reduces a position the server itself opened always passes the
  caps, so exits are never blocked. The ledger is kept in
  `data/live_order_ledger.json`, and the trading day resets at midnight IST.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values
npm run dev            # http://localhost:3000
```

Production build:

```bash
npm run build && npm start
```

Type-check:

```bash
npm run lint
```

### Environment variables

See `.env.example` for the full list. At minimum you need:

| Variable | Purpose |
|---|---|
| `ALLOWED_EMAILS` | Accounts allowed to use the server (required) |
| `GEMINI_API_KEY` | AI agents (without it, the rule-based fallbacks are used) |
| `COINDCX_API_KEY`, `COINDCX_API_SECRET` | Live CoinDCX balances and orders |
| `ZERODHA_API_KEY`, `ZERODHA_API_SECRET` | Zerodha Kite login, ticker and candles |
| `LIVE_TRADING_ENABLED` + `LIVE_*` limits | Server-side live-order limits |

### Firestore rules

Deploy `firestore.rules` to your Firebase project. Clients can no longer write
the `users/{uid}/credentials` documents. The Security Console → Exchange API
tab can delete a legacy plain-text key document left by earlier builds.
