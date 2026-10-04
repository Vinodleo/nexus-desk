import fs from "fs";
import path from "path";
import { fetchCoinBalances, getLivePosition, hasCoinDcxKeys, orderStatus, requestLiveExit } from "./liveExecution";
import { coinDcxMarket, placeLiveEntry } from "./liveEntry";
import { loadLiveRiskConfig, type LiveRiskConfig } from "./liveOrderGuard";
import { getReferencePrice } from "./routes/coindcx";
import { TEST_NEEDS_INR, TEST_ORDER_INR, type LiveTestReport, type LiveTestRun } from "../src/shared/liveTest";

// The live test order (Settings → Connections): one small real buy at
// CoinDCX (TEST_ORDER_INR) and, when the owner taps Sell, its sale. It goes
// through the same path as every live trade: the server's live checks
// (LIVE_TRADING_ENABLED, LIVE_ALLOWED_MARKETS, the caps), the live record
// (so the CoinDCX check sees it), and the server-sent exit. It works with the
// desk left on Paper, so nothing else trades live meanwhile. It isn't in the
// guardian: no stop, no target; it's held only until the owner sells it.
//
// It reads CoinDCX's balances before and after each order, which answers the
// open question from the API check: whether the buying fee comes out of the
// coins (then CoinDCX holds a little less than was bought, and a sale of the
// whole quantity is refused) or out of rupees.

const STATE_FILE = "live_test.json";
/** How long to let a market order fill before asking CoinDCX how it went. */
const SETTLE_MS = 3000;

const dataDir = () => process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const coinOf = (market: string) => market.replace(/(INR|USDT)$/, "");

interface TestState {
  userId: string;
  run: LiveTestRun;
}

let state: TestState | null = null;
let loaded = false;
let busy = false;

export interface LiveTestDeps {
  now: () => number;
  dir: () => string;
  keys: () => boolean;
  config: () => LiveRiskConfig;
  price: (market: string) => Promise<number | undefined>;
  balances: () => Promise<Record<string, number>>;
  placeEntry: typeof placeLiveEntry;
  exit: typeof requestLiveExit;
  record: typeof getLivePosition;
  status: typeof orderStatus;
  wait: (ms: number) => Promise<void>;
}

const realDeps: LiveTestDeps = {
  now: () => Date.now(),
  dir: dataDir,
  keys: hasCoinDcxKeys,
  config: loadLiveRiskConfig,
  price: getReferencePrice,
  balances: fetchCoinBalances,
  placeEntry: placeLiveEntry,
  exit: requestLiveExit,
  record: getLivePosition,
  status: orderStatus,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function load(dir: string): void {
  if (loaded) return;
  loaded = true;
  try {
    const file = path.join(dir, STATE_FILE);
    if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
}

function save(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${STATE_FILE}.tmp`), JSON.stringify(state), "utf8");
    fs.renameSync(path.join(dir, `${STATE_FILE}.tmp`), path.join(dir, STATE_FILE));
  } catch {}
}

/** A sale sent earlier: how it stands now in the live record (the server retries refused exits itself). */
function refresh(deps: LiveTestDeps): void {
  if (!state || state.run.status !== "SELLING") return;
  const rec = deps.record(state.run.positionId);
  if (rec?.status === "CLOSED") state.run = { ...state.run, status: "SOLD", soldAt: rec.closedAt, error: undefined };
  else if (rec?.status === "EXIT_FAILED") state.run = { ...state.run, status: "SELL_FAILED", error: rec.lastError };
  else if (rec?.lastError) state.run = { ...state.run, error: rec.lastError };
  save(deps.dir());
}

const delta = (after: Record<string, number> | null, before: Record<string, number> | null, currency: string) =>
  after && before ? Number(((after[currency] ?? 0) - (before[currency] ?? 0)).toFixed(8)) : undefined;

/** For Settings: whether a test can run, and the last one. */
export function liveTestStatus(userId: string, deps: LiveTestDeps = realDeps): LiveTestReport {
  load(deps.dir());
  refresh(deps);
  const cfg = deps.config();
  return { keys: deps.keys(), liveEnabled: cfg.enabled, markets: [...cfg.allowedMarkets], amountInr: TEST_ORDER_INR, run: state && state.userId === userId ? state.run : null };
}

export type LiveTestResult = { ok: true; run: LiveTestRun } | { ok: false; status: number; error: string };

/** Buys TEST_ORDER_INR of `market` at CoinDCX, for real. */
export async function startLiveTest(userId: string, symbol: string, deps: LiveTestDeps = realDeps): Promise<LiveTestResult> {
  load(deps.dir());
  refresh(deps);
  if (busy) return { ok: false, status: 409, error: "A test order is already being sent." };
  if (state && (state.run.status === "BOUGHT" || state.run.status === "SELLING"))
    return { ok: false, status: 409, error: `The last test's ${state.run.coin} isn't sold yet: sell it first.` };
  if (!deps.keys()) return { ok: false, status: 400, error: "No CoinDCX keys on the server (COINDCX_API_KEY, COINDCX_API_SECRET)." };
  const cfg = deps.config();
  if (!cfg.enabled) return { ok: false, status: 403, error: "Live trading is off on the server (LIVE_TRADING_ENABLED isn't \"true\")." };
  const market = coinDcxMarket(symbol);
  if (!cfg.allowedMarkets.has(market)) return { ok: false, status: 400, error: `${market} isn't on LIVE_ALLOWED_MARKETS.` };
  const coin = coinOf(market);
  busy = true;
  try {
    const price = await deps.price(market);
    if (!price) return { ok: false, status: 503, error: `No price for ${market} on the server just now; try again in a minute.` };
    // Reading the balances first also checks the keys work, before any money moves.
    let before: Record<string, number>;
    try {
      before = await deps.balances();
    } catch (err: any) {
      return { ok: false, status: 502, error: `Couldn't read your CoinDCX balances (${err?.message || err}).` };
    }
    if ((before.INR ?? 0) < TEST_NEEDS_INR)
      return { ok: false, status: 400, error: `CoinDCX has ₹${(before.INR ?? 0).toFixed(2)}; the test needs about ₹${TEST_NEEDS_INR} (₹${TEST_ORDER_INR} and the fee).` };

    const positionId = `livetest-${deps.now()}`;
    const result = await deps.placeEntry({ userId, positionId, symbol: market, side: "buy", quantity: TEST_ORDER_INR / price, price });
    if (!result.ok) return { ok: false, status: result.status, error: result.error };
    state = {
      userId,
      run: { positionId, market, coin, status: "BOUGHT", quantity: result.quantity, boughtAt: new Date(deps.now()).toISOString(), buyOrderId: result.orderId },
    };
    save(deps.dir());
    console.log(`[LiveTest] Bought ${result.quantity} ${market} for the live test (order ${result.orderId}).`);

    // How it filled, and what CoinDCX now holds.
    await deps.wait(SETTLE_MS);
    const rec = deps.record(positionId);
    const filled = rec ? await deps.status({ orderId: rec.entryOrderId, clientOrderId: rec.entryClientOrderId }) : undefined;
    const after = await deps.balances().catch(() => null);
    state.run = { ...state.run, buyPrice: filled?.avgPrice, coinReceived: delta(after, before, coin), inrSpent: delta(before, after, "INR") };
    save(deps.dir());
    return { ok: true, run: state.run };
  } finally {
    busy = false;
  }
}

/** Sells the test's coin through the server's live exit (the same one every live trade's close takes). */
export async function sellLiveTest(userId: string, deps: LiveTestDeps = realDeps): Promise<LiveTestResult> {
  load(deps.dir());
  refresh(deps);
  if (!state || state.userId !== userId) return { ok: false, status: 404, error: "No test order to sell." };
  if (state.run.status !== "BOUGHT") return { ok: true, run: state.run };
  if (busy) return { ok: false, status: 409, error: "The test order is busy; try again in a moment." };
  busy = true;
  try {
    const before = await deps.balances().catch(() => null);
    state.run = { ...state.run, status: "SELLING" };
    save(deps.dir());
    const rec = await deps.exit(state.run.positionId, "TEST_ORDER");
    if (!rec) return { ok: false, status: 404, error: "The server has no live record of the test order." };
    if (rec.status !== "CLOSED") {
      state.run = { ...state.run, status: rec.status === "EXIT_FAILED" ? "SELL_FAILED" : "SELLING", error: rec.lastError };
      save(deps.dir());
      return { ok: true, run: state.run };
    }
    await deps.wait(SETTLE_MS);
    const sold = rec.exitClientOrderId ? await deps.status({ orderId: rec.exitOrderId, clientOrderId: rec.exitClientOrderId }) : undefined;
    const after = await deps.balances().catch(() => null);
    state.run = { ...state.run, status: "SOLD", soldAt: rec.closedAt, sellPrice: sold?.avgPrice, inrReceived: delta(after, before, "INR"), error: undefined };
    save(deps.dir());
    console.log(`[LiveTest] Sold the live test's ${state.run.coin}.`);
    return { ok: true, run: state.run };
  } finally {
    busy = false;
  }
}

/** Test hook. */
export function _resetLiveTest(): void {
  state = null;
  loaded = false;
  busy = false;
}
