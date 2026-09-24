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

- **Live exits are sent by the server** (`server/liveExecution.ts`).
  - Every accepted live entry is registered by its position ID
    (`data/live_positions.json`).
  - When the guardian hits a stop, target or expiry, or you close the
    position, the server sends the market exit itself. A closed browser can't
    leave a real position open.
  - Each exit has a fixed `client_order_id`. Before any re-send, the server
    looks the order up on CoinDCX (`/exchange/v1/orders/status`) so an exit is
    never sent twice.
  - Failed exits retry with backoff. After 10 attempts the server logs
    `EXIT FAILED` and alerts the client. **Before going live, confirm
    that the order-status endpoint accepts `client_order_id`.**
- **Positions are per user.** Guardian positions and events are scoped to the
  Firebase user, and a sync can't drop an open live position.

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

Always-on hosting (so scanning and the position guardian keep running with
the app closed): see [docs/hosting.md](docs/hosting.md). It covers Cloud Run
(`scripts/cloudrun-always-on.sh`), your own VM (`docker compose up -d`) or
Fly.io (`fly.toml`, deployed by GitHub Actions on every merge).

Type-check:

```bash
npm run lint
```

### Tests

```bash
npm test            # unit tests (Vitest): risk engine, fees/P&L, guardian stops,
                    # live-order limits, live exits (fake CoinDCX), auth
npm run test:rules  # Firestore rules against the emulator (needs Java 11+)
```

CI (`.github/workflows/ci.yml`) runs typecheck, unit tests and the build, plus
the rules suite, on every pull request and on pushes to `main`.

### Environment variables

See `.env.example` for the full list. At minimum you need:

| Variable | Purpose |
|---|---|
| `ALLOWED_EMAILS` | Accounts allowed to use the server (required) |
| `GEMINI_API_KEY` | AI agents (without it, the rule-based fallbacks are used) |
| `COINDCX_API_KEY`, `COINDCX_API_SECRET` | Live CoinDCX balances and orders |
| `ZERODHA_API_KEY`, `ZERODHA_API_SECRET` | Zerodha Kite login, ticker and candles |
| `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_PIN`, `ANGEL_TOTP_SECRET` | Indian stocks (Nifty 50) via Angel One SmartAPI: candles, live prices, depth |
| `LIVE_TRADING_ENABLED` + `LIVE_*` limits | Server-side live-order limits |

### Firestore rules

The app uses its own Firebase project, `nexus-desk-21656` (sign-in and the `(default)` Firestore database; `firebase-applet-config.json`). Deploy `firestore.rules` with `npx firebase-tools deploy --only firestore:rules --project nexus-desk-21656`, or paste the file into the console: Firestore → Rules → Publish. Sign-in works only on addresses listed under Authentication → Settings → Authorised domains (add `nexus-desk-vinodleo.fly.dev`, and `localhost` for local runs).
- Profiles and everything under them can be read and written only by
  their owner.
- `uid`, `email` and `createdAt` are fixed once a profile exists, and
  profile fields must be on an allow-list and have the right type.
- Positions and audit logs have strict shapes. Audit logs are append-only
  and time-stamped by the server.
- Clients can't write `users/{uid}/credentials`. The Security Console →
  Exchange API tab can delete a legacy plain-text key document left by
  earlier builds.
