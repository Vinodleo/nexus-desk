import fs from "fs";
import path from "path";
import { BREAKOUT_READINGS_VERSION, type BreakoutSetup, type MlStrategy } from "../../src/services/breakoutModel";

// Every replayed breakout 55/20 trade with its readings at entry, kept for
// the machine-learning test on breakout trades (history/mlTest.ts): the
// coins' from the daily replay since 2017 (history/dailyLong.ts), US stocks'
// from the stocks' replay since 2016 (history/stocksLong.ts). Momentum's
// trades the same way, in files of their own. A few hundred trades each, so
// plain JSON.

/** The markets breakout paper-trades. */
export type BreakoutMarket = "coins" | "us";
export const BREAKOUT_MARKETS: BreakoutMarket[] = ["coins", "us"];

export interface SavedBreakoutSetups {
  version: number;
  /** When the replay saved them: a new save means the test is due again. */
  savedAt: number;
  setups: BreakoutSetup[];
}

/** "breakout_setups_coins.json", "momentum_setups_us.json". */
const fileOf = (market: BreakoutMarket, strategy: MlStrategy) =>
  path.join(process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data"), `${strategy}_setups_${market}.json`);

export function saveBreakoutSetups(market: BreakoutMarket, setups: BreakoutSetup[], now: number, strategy: MlStrategy = "breakout"): void {
  const file = fileOf(market, strategy);
  try {
    const body: SavedBreakoutSetups = { version: BREAKOUT_READINGS_VERSION, savedAt: now, setups };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(body), "utf8");
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn(`[BreakoutSetups] Couldn't save the ${market} ${strategy} setups:`, err);
  }
}

/** A market's saved setups of a strategy, or null without any (or saved with older readings). */
export function readBreakoutSetups(market: BreakoutMarket, strategy: MlStrategy = "breakout"): SavedBreakoutSetups | null {
  const file = fileOf(market, strategy);
  try {
    if (!fs.existsSync(file)) return null;
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as SavedBreakoutSetups;
    return saved?.version === BREAKOUT_READINGS_VERSION && Array.isArray(saved.setups) ? saved : null;
  } catch (err) {
    console.warn(`[BreakoutSetups] Couldn't read the ${market} ${strategy} setups:`, err);
    return null;
  }
}
