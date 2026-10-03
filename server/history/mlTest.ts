import fs from "fs";
import path from "path";
import { promisify } from "util";
import { gunzip } from "zlib";
import { backgroundWorkBusy, CPU_SHARE, historyRunInfo, historyRunning, setupsDir, setupsFileName, waitForOtherWork } from "./historyJob";
import { scannerHeartbeat } from "../scanner/scannerService";
import { scanningDesks } from "../scanner/deskState";
import {
  addRow,
  binEdges,
  emptyTable,
  featureList,
  importance,
  judge,
  linesOf,
  readSetupLines,
  trainBoosted,
  type MarketVerdict,
  type SetupRow,
  type SetupTable,
} from "../../src/services/setupModel";
import type { MarketKind } from "../../src/services/exitExpectancy";
import { DEFAULT_TRAIL_PROFILE } from "../../src/shared/trailingStop";
import { isNseSymbol } from "../../src/shared/nse";
import { isUsSymbol } from "../../src/shared/usMarket";

// The machine-learning test, run on the server where the replayed setups are
// kept (history_setups/, from the two-year replay). It reads them twice:
// once to count them and set each reading's bins, once to load them, a byte
// a reading. The oldest months train the model, the 3 months after tune it,
// and the latest 6 months judge it (src/services/setupModel.ts). Like the
// replay, it works in bursts and rests (CPU_SHARE of a core), waits while a
// scan cycle runs, and doesn't start while a replay is going. It runs once a
// replay has finished (again after each new one), or when asked from the Lab,
// and keeps only its verdict (ml_test.json). It decides nothing live.

/** Bump when the test changes enough that an old verdict no longer stands. */
export const ML_TEST_VERSION = 1;
/** The latest months judge; the months before them tune. */
const TEST_DAYS = 182;
const VALID_DAYS = 91;
/**
 * At most this many training setups are loaded (evenly spread), to stay well
 * inside the server's memory (512 MB, shared with everything else): loaded,
 * a setup takes about 65 bytes, so all three periods take about 55 MB.
 */
export const MAX_TRAIN_SETUPS = 300_000;
/** Setups sampled to set the readings' bins. */
const EDGE_SAMPLE = 20_000;
/**
 * The server has 512 MB, and running out stops everything (Fly ends the
 * machine). The test sizes what it loads to stay under MEMORY_PLAN_MB with
 * room to spare, and stops (freeing what it loaded) if the server's memory
 * passes MEMORY_STOP_MB anyway.
 */
export const MEMORY_PLAN_MB = 400;
export const MEMORY_STOP_MB = 450;
/** Room kept for a file being read and the work in between. */
const MEMORY_MARGIN_MB = 60;
/** Fewer training setups than this isn't worth learning from. */
const MIN_TRAIN_SETUPS = 50_000;
const MB = 1024 * 1024;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const CYCLE_WAIT_MS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const gunzipAsync = promisify(gunzip);

const file = () => path.join(process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data"), "ml_test.json");

export interface MlTestResult {
  version: number;
  ranAt: number;
  /** The replay it learned from (its finish time). */
  historyFinishedAt: number;
  /** The exit profile whose results it learned. */
  profile: string;
  periods: { trainFrom: number; validFrom: number; testFrom: number; testTo: number };
  setups: { train: number; trainUsed: number; valid: number; test: number };
  trees: number;
  /** What it relied on most. */
  importance: { label: string; share: number }[];
  markets: Record<MarketKind, MarketVerdict | null>;
}

export type MlPhase = "idle" | "reading" | "training" | "judging";

export interface MlDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  scannerBusy: () => boolean;
  /** The exit profile to learn: the owner's. */
  profile: () => string;
  /** At most this many training setups are loaded (MAX_TRAIN_SETUPS). */
  maxTrainSetups?: number;
  /** The server's memory in use (bytes). */
  memory: () => number;
}

const realDeps: MlDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  scannerBusy: () => scannerHeartbeat().cycleRunning,
  profile: () => scanningDesks()[0]?.[1].trailProfile ?? DEFAULT_TRAIL_PROFILE,
  memory: () => process.memoryUsage().rss,
};

let result: MlTestResult | null = null;
let phase: MlPhase = "idle";
let trees = 0;
let lastError: string | null = null;
let active: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function loadMlTest(): void {
  try {
    if (fs.existsSync(file())) result = JSON.parse(fs.readFileSync(file(), "utf8")) as MlTestResult;
  } catch (err) {
    console.warn("[MlTest] Couldn't read the saved verdict:", err);
  }
}

function saveMlTest(): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(`${file()}.tmp`, JSON.stringify(result), "utf8");
    fs.renameSync(`${file()}.tmp`, file());
  } catch (err) {
    console.warn("[MlTest] Couldn't save the verdict:", err);
  }
}

const marketOf = (symbol: string): MarketKind => (isUsSymbol(symbol) ? "us" : isNseSymbol(symbol) ? "nse" : "crypto");

/** Whether a finished replay has setups the current verdict didn't learn from. */
export function mlTestDue(): boolean {
  const run = historyRunInfo();
  if (!run?.finishedAt || !Object.values(run.markets).some((m) => (m.setups ?? 0) > 0)) return false;
  return !result || result.version !== ML_TEST_VERSION || result.historyFinishedAt !== run.finishedAt;
}

async function work(deps: MlDeps): Promise<void> {
  const run = historyRunInfo();
  if (!run?.finishedAt) throw new Error("The two-year replay hasn't finished yet.");
  const profile = deps.profile();
  const testFrom = run.toMs - TEST_DAYS * DAY_MS;
  const validFrom = testFrom - VALID_DAYS * DAY_MS;
  const markets = Object.entries(run.markets)
    .filter(([, m]) => (m.setups ?? 0) > 0)
    .map(([symbol], id) => ({ symbol, id, market: marketOf(symbol), path: path.join(setupsDir(), setupsFileName(symbol)) }))
    .filter((m) => fs.existsSync(m.path));
  /** Rests after `took` ms of work, so the test averages CPU_SHARE of a core; waits for a scan cycle. */
  const rest = async (took: number) => {
    if (deps.memory() > MEMORY_STOP_MB * MB) throw new Error(`Stopped to keep the server safe: its memory reached ${Math.round(deps.memory() / MB)} MB.`);
    await deps.sleep(Math.max(1, Math.round(took * (1 / CPU_SHARE - 1))));
    while (deps.scannerBusy()) await deps.sleep(CYCLE_WAIT_MS);
  };
  /** Each market's setups (a file at a time), as rows read with these features. */
  const eachMarket = async (features: ReturnType<typeof featureList>, traders: string[], use: (row: SetupRow) => void) => {
    for (const m of markets) {
      const text = (await gunzipAsync(fs.readFileSync(m.path))).toString();
      const started = deps.now();
      const lines = linesOf(text);
      const header = lines.next().value ?? "";
      for (const row of readSetupLines(lines, header, m.market, m.id, features, traders, profile)) use(row);
      await rest(deps.now() - started);
    }
  };
  const periodOf = (row: SetupRow) => (row.entryMs >= testFrom ? "test" : row.entryMs >= validFrom ? "valid" : "train");

  // 1. Count each period's setups, find the traders, and sample readings for the bins.
  phase = "reading";
  // Only the numbers here: the yes/no features need no bins worked out.
  const numbers = featureList([]).filter((f) => !f.flag);
  const counts = { train: 0, valid: 0, test: 0 };
  const traders = new Set<string>();
  const sample: number[][] = [];
  let seen = 0;
  await eachMarket(numbers, [], (row) => {
    counts[periodOf(row)]++;
    traders.add(row.trader);
    if (periodOf(row) !== "train") return;
    // Reservoir sample: every training setup equally likely to be kept.
    seen++;
    if (sample.length < EDGE_SAMPLE) sample.push(Array.from(row.values));
    else {
      const k = Math.floor(Math.random() * seen);
      if (k < EDGE_SAMPLE) sample[k] = Array.from(row.values);
    }
  });
  if (counts.train === 0 || counts.valid === 0 || counts.test === 0) throw new Error("Too few saved setups in one of the periods.");
  const traderList = [...traders].sort();
  const features = featureList(traderList);
  const numberEdges = binEdges(sample, numbers);
  const edges = features.map((f) => (f.flag ? [0.5] : numberEdges[numbers.findIndex((n) => n.name === f.name)]));

  // 2. Load them, binned: every validation and test setup, and an even spread
  //    of training ones, as many as the server's free memory allows.
  const bytesPerSetup = features.length + 25;
  const room = Math.floor(((MEMORY_PLAN_MB - MEMORY_MARGIN_MB) * MB - deps.memory()) / bytesPerSetup) - counts.valid - counts.test;
  if (room < Math.min(MIN_TRAIN_SETUPS, counts.train)) {
    throw new Error(`Not enough free memory on the server (${Math.round(deps.memory() / MB)} MB in use); try again later.`);
  }
  const trainCap = Math.min(deps.maxTrainSetups ?? MAX_TRAIN_SETUPS, room);
  const stride = Math.max(1, Math.ceil(counts.train / trainCap));
  const tables: Record<"train" | "valid" | "test", SetupTable> = {
    train: emptyTable(Math.ceil(counts.train / stride), features.length),
    valid: emptyTable(counts.valid, features.length),
    test: emptyTable(counts.test, features.length),
  };
  let trainIndex = 0;
  await eachMarket(features, traderList, (row) => {
    const period = periodOf(row);
    if (period === "train" && trainIndex++ % stride !== 0) return;
    addRow(tables[period], row, edges);
  });

  // 3. Train, a tree at a time.
  phase = "training";
  trees = 0;
  const training = trainBoosted(tables.train, tables.valid);
  let started = deps.now();
  let step = training.next();
  while (!step.done) {
    trees = step.value;
    await rest(deps.now() - started);
    started = deps.now();
    step = training.next();
  }
  const model = step.value;

  // 4. Judge on the latest months.
  phase = "judging";
  result = {
    version: ML_TEST_VERSION,
    ranAt: deps.now(),
    historyFinishedAt: run.finishedAt,
    profile,
    periods: { trainFrom: run.fromMs, validFrom, testFrom, testTo: run.toMs },
    setups: { train: counts.train, trainUsed: tables.train.n, valid: tables.valid.n, test: tables.test.n },
    trees: model.trees.length,
    importance: importance(model, features).slice(0, 6),
    markets: judge(model, tables.valid, tables.test),
  };
  saveMlTest();
  console.log(`[MlTest] Done: ${model.trees.length} trees; passed in ${Object.entries(result.markets).filter(([, v]) => v?.passed).map(([m]) => m).join(", ") || "no market"}.`);
}

/** Runs the test now unless it's running or a replay is (it can't start before a replay has finished). */
export function startMlTest(deps: MlDeps = realDeps): Promise<void> {
  if (active) return active;
  if (historyRunning()) return Promise.resolve();
  lastError = null;
  active = work(deps)
    .catch((err) => {
      lastError = err?.message || String(err);
      console.error("[MlTest] Failed:", err);
    })
    .finally(() => {
      active = null;
      phase = "idle";
    });
  return active;
}

/** Loads the kept verdict, and checks hourly whether a newly finished replay needs testing. */
export function startMlTestJob(): void {
  loadMlTest();
  waitForOtherWork(() => active !== null);
  const check = () => {
    timer = setTimeout(check, CHECK_EVERY_MS);
    if (!active && !historyRunning() && !backgroundWorkBusy() && mlTestDue()) void startMlTest();
  };
  timer = setTimeout(check, CHECK_EVERY_MS);
}

/** What the Lab shows. */
export function mlTestView() {
  const run = historyRunInfo();
  return {
    running: active !== null,
    phase,
    trees,
    error: lastError,
    /** It can run: a replay has finished with setups saved, and none is going. */
    ready: !!run?.finishedAt && !historyRunning() && Object.values(run.markets).some((m) => (m.setups ?? 0) > 0),
    result,
  };
}

/** Test hooks. */
export function _resetMlTest(): void {
  result = null;
  phase = "idle";
  trees = 0;
  lastError = null;
  active = null;
  if (timer) clearTimeout(timer);
  timer = null;
}
