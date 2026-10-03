import fs from "fs";
import path from "path";
import { BREAKOUT_READINGS_VERSION, type BreakoutSetup } from "../../src/services/breakoutModel";

// Every replayed breakout 55/20 trade with its readings at entry, kept for
// the machine-learning test on breakout trades (history/mlTest.ts): the
// coins' from the daily replay since 2017 (history/dailyLong.ts), US stocks'
// from the stocks' replay since 2016 (history/stocksLong.ts). A few hundred
// trades each, so plain JSON.

/** The markets breakout paper-trades. */
export type BreakoutMarket = "coins" | "us";
export const BREAKOUT_MARKETS: BreakoutMarket[] = ["coins", "us"];

export interface SavedBreakoutSetups {
  version: number;
  /** When the replay saved them: a new save means the test is due again. */
  savedAt: number;
  setups: BreakoutSetup[];
}

const fileOf = (market: BreakoutMarket) => path.join(process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data"), `breakout_setups_${market}.json`);

export function saveBreakoutSetups(market: BreakoutMarket, setups: BreakoutSetup[], now: number): void {
  try {
    const body: SavedBreakoutSetups = { version: BREAKOUT_READINGS_VERSION, savedAt: now, setups };
    fs.mkdirSync(path.dirname(fileOf(market)), { recursive: true });
    fs.writeFileSync(`${fileOf(market)}.tmp`, JSON.stringify(body), "utf8");
    fs.renameSync(`${fileOf(market)}.tmp`, fileOf(market));
  } catch (err) {
    console.warn(`[BreakoutSetups] Couldn't save the ${market} setups:`, err);
  }
}

/** A market's saved setups, or null without any (or saved with older readings). */
export function readBreakoutSetups(market: BreakoutMarket): SavedBreakoutSetups | null {
  try {
    if (!fs.existsSync(fileOf(market))) return null;
    const saved = JSON.parse(fs.readFileSync(fileOf(market), "utf8")) as SavedBreakoutSetups;
    return saved?.version === BREAKOUT_READINGS_VERSION && Array.isArray(saved.setups) ? saved : null;
  } catch (err) {
    console.warn(`[BreakoutSetups] Couldn't read the ${market} setups:`, err);
    return null;
  }
}
