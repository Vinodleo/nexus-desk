import { LIVE_MODEL_PATH, loadMetaModel, predictConfidenceBatch, trainMetaModel } from "./mlService";
import { loadStoredPromotedLabModel, saveStoredPromotedLabModel } from "./storagePersistenceService";
import { META_FEATURE_COUNT, META_FEATURE_VERSION } from "./metaFeatures";
import { oneShadowAtATime, type ShadowSignal } from "./shadowTracker";
import { outcomeScore } from "./calibration";
import type { PromotedLabModel } from "../types";
import type * as tf from "@tensorflow/tfjs";

// Daily retraining of the confidence model on what actually happened: every
// shadow-tracked intraday setup from the last 30 days, with the model inputs
// recorded when it was found (the same ones the Lab and live scoring use),
// labelled by how far it got toward its target (the calibration's win scale:
// the target 1, the stop 0, in between by how far it got), so the model
// learns what setups make, not just how often they end ahead.
//
// A retrained model goes live only if it would have picked better. The
// latest week is held back: the model learns from the three weeks before,
// then on the held-back week the half of the setups it rates best must have
// earned more per setup (in R, after fees) than the half the live model rates
// best, and than all of them together. Otherwise the live model stays.

const LAST_TRAINING_KEY = "nexus_last_online_training_timestamp";
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * DAY_MS;
/** The latest week's setups are held back to test a retrained model on. */
export const TEST_WINDOW_MS = 7 * DAY_MS;
/** Finished setups needed to learn from (older than the held-back week), and to test on. */
export const MIN_TRAIN_SAMPLES = 120;
export const MIN_TEST_SAMPLES = 30;
/** Finished setups needed before the model is retrained on them. */
export const MIN_ONLINE_SAMPLES = MIN_TRAIN_SAMPLES + MIN_TEST_SAMPLES;
/** The note the latest check leaves on the model in use (the Lab shows it). */
export const RETRAIN_LESSON_ID = "online-retrain";

export interface TrainingSet {
  features: number[][];
  labels: number[];
  /** Each setup's result in R after fees, and when it appeared. */
  r: number[];
  times: number[];
}

export function onlineTrainingSet(shadows: ShadowSignal[], nowMs: number = Date.now()): TrainingSet {
  const set: TrainingSet = { features: [], labels: [], r: [], times: [] };
  const usable = shadows.filter(
    (s) => s.horizon === "intraday" && s.features?.length === META_FEATURE_COUNT && nowMs - s.signalTime <= WINDOW_MS
  );
  // Each price move once (oneShadowAtATime), not once per candle it stayed valid.
  for (const s of oneShadowAtATime(usable)) {
    if (s.status === "open" || s.r === undefined) continue;
    set.features.push(s.features!);
    set.labels.push(outcomeScore(s) ?? (s.r > 0 ? 1 : 0));
    set.r.push(s.r);
    set.times.push(s.signalTime);
  }
  return set;
}

const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Average result (R) of the half of the setups a model rates best (the larger half when odd). */
export function topHalfR(scores: number[], r: number[]): number {
  const order = r.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  return mean(order.slice(0, Math.ceil(order.length / 2)).map((i) => r[i]));
}

export interface RetrainVerdict {
  /** Average R of the best-rated half: the retrained model's, and the live one's (null with none). */
  challengerR: number;
  championR: number | null;
  /** Average R of every held-back setup. */
  allR: number;
  tested: number;
  switched: boolean;
}

/**
 * Whether a retrained model replaces the live one: on the held-back setups,
 * its best-rated half must have earned more than the live model's, and more
 * than all of them together (picking no better than taking everything adds
 * nothing).
 */
export function judgeChallenger(r: number[], challengerScores: number[], championScores: number[] | null): RetrainVerdict {
  const allR = mean(r);
  const challengerR = topHalfR(challengerScores, r);
  const championR = championScores ? topHalfR(championScores, r) : null;
  return { challengerR, championR, allR, tested: r.length, switched: challengerR > allR && (championR === null || challengerR > championR) };
}

const rSigned = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;

/** What the check found, in words, for the Lab's notes. */
export function retrainNote(v: RetrainVerdict, trained: number): string {
  const against = `${v.championR !== null ? `${rSigned(v.championR)} for the model in use and ` : ""}${rSigned(v.allR)} for all of them`;
  return `Retrained on ${trained} tracked setups; on the latest week's ${v.tested} it hadn't seen, the half it rated best earned ${rSigned(
    v.challengerR
  )} each, against ${against}. ${v.switched ? "Switched to it." : "Kept the model in use."}`;
}

function withNote(model: PromotedLabModel, rule: string): PromotedLabModel {
  const lessons = model.distilledLessons.filter((l) => l.id !== RETRAIN_LESSON_ID && l.id !== "online-1");
  const note = { id: RETRAIN_LESSON_ID, rule, regime: "All Regimes", action: "Online Learning TFJS Model" };
  return { ...model, distilledLessons: [...lessons, note], distilledRulesCount: lessons.length + 1 };
}

export interface RetrainDeps {
  train: (features: number[][], labels: number[]) => Promise<tf.LayersModel | null>;
  /** The model in use now, or null. */
  loadLive: () => Promise<tf.LayersModel | null>;
  predict: (model: tf.LayersModel, features: number[][]) => number[];
  saveLive: (model: tf.LayersModel) => Promise<unknown>;
}

const defaultDeps: RetrainDeps = {
  train: trainMetaModel,
  loadLive: () => loadMetaModel(LIVE_MODEL_PATH),
  predict: predictConfidenceBatch,
  saveLive: (model) => model.save(LIVE_MODEL_PATH),
};

/** Retrains once a day when there's enough to learn from and test on. True if the retrained model went live. */
export async function checkAndRunOnlineLearning(shadows: ShadowSignal[], now: number = Date.now(), deps: RetrainDeps = defaultDeps): Promise<boolean> {
  let lastTraining = 0;
  try {
    lastTraining = Number(localStorage.getItem(LAST_TRAINING_KEY)) || 0;
  } catch {}
  if (now - lastTraining < DAY_MS) return false;

  const all = onlineTrainingSet(shadows, now);
  const split = now - TEST_WINDOW_MS;
  const pick = (keep: (t: number) => boolean) => {
    const idx = all.times.map((t, i) => (keep(t) ? i : -1)).filter((i) => i >= 0);
    return { features: idx.map((i) => all.features[i]), labels: idx.map((i) => all.labels[i]), r: idx.map((i) => all.r[i]) };
  };
  const train = pick((t) => t < split);
  const test = pick((t) => t >= split);
  // Try again when more have finished.
  if (train.features.length < MIN_TRAIN_SAMPLES || test.features.length < MIN_TEST_SAMPLES) return false;

  try {
    const challenger = await deps.train(train.features, train.labels);
    if (!challenger) return false;
    const current = loadStoredPromotedLabModel();
    // A live model on other inputs can't be scored on these; the retrained one then only has to beat taking everything.
    const champion = current?.hasTrainedModel && current.featureVersion === META_FEATURE_VERSION ? await deps.loadLive() : null;
    const verdict = judgeChallenger(
      test.r,
      deps.predict(challenger, test.features),
      champion ? deps.predict(champion, test.features) : null
    );
    const note = retrainNote(verdict, train.features.length);

    if (verdict.switched) {
      await deps.saveLive(challenger);
      const scorePct = Number((mean(train.labels) * 100).toFixed(1));
      saveStoredPromotedLabModel(
        withNote(
          current
            ? { ...current, promotedAt: new Date(now).toISOString(), hasTrainedModel: true, featureVersion: META_FEATURE_VERSION }
            : {
                // No Lab settings here, so no Lab-tuned trader joins the panel.
                promotedAt: new Date(now).toISOString(),
                datasetName: "Online Learning (Rolling 30-Day Window)",
                accuracyPct: scorePct,
                winRatePct: scorePct,
                sharpeRatio: 0,
                totalCandlesEvaluated: 0,
                distilledRulesCount: 0,
                distilledLessons: [],
                hasTrainedModel: true,
                featureVersion: META_FEATURE_VERSION,
              },
          note
        )
      );
    } else if (current) {
      saveStoredPromotedLabModel(withNote(current, note));
    }
    try {
      localStorage.setItem(LAST_TRAINING_KEY, String(now));
    } catch {}
    console.log(`[OnlineLearning] ${note}`);
    window.dispatchEvent(new CustomEvent("nexus-model-trained", { detail: { count: train.features.length, timestamp: now, switched: verdict.switched } }));
    return verdict.switched;
  } catch (error) {
    console.error("Failed to run continuous online learning", error);
    return false;
  }
}
