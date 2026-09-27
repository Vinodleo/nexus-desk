import { LIVE_MODEL_PATH, trainMetaModel } from "./mlService";
import { loadStoredPromotedLabModel, saveStoredPromotedLabModel } from "./storagePersistenceService";
import { META_FEATURE_COUNT, META_FEATURE_VERSION } from "./metaFeatures";
import { oneShadowAtATime, type ShadowSignal } from "./shadowTracker";
import { outcomeScore } from "./calibration";
import type * as tf from "@tensorflow/tfjs";

// Daily retraining of the confidence model on what actually happened: every
// shadow-tracked intraday setup from the last 30 days, with the model inputs
// recorded when it was found (the same ones the Lab and live scoring use),
// labelled by how far it got toward its target (the calibration's win scale:
// the target 1, the stop 0, in between by how far it got), so the model
// learns what setups make, not just how often they end ahead.

const LAST_TRAINING_KEY = "nexus_last_online_training_timestamp";
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * DAY_MS;
/** Finished setups needed before the model is retrained on them. */
export const MIN_ONLINE_SAMPLES = 150;

export function onlineTrainingSet(shadows: ShadowSignal[], nowMs: number = Date.now()): { features: number[][]; labels: number[] } {
  const features: number[][] = [];
  const labels: number[] = [];
  const usable = shadows.filter(
    (s) => s.horizon === "intraday" && s.features?.length === META_FEATURE_COUNT && nowMs - s.signalTime <= WINDOW_MS
  );
  // Each price move once (oneShadowAtATime), not once per candle it stayed valid.
  for (const s of oneShadowAtATime(usable)) {
    if (s.status === "open" || s.r === undefined) continue;
    features.push(s.features!);
    labels.push(outcomeScore(s) ?? (s.r > 0 ? 1 : 0));
  }
  return { features, labels };
}

export async function checkAndRunOnlineLearning(shadows: ShadowSignal[]): Promise<boolean> {
  let lastTraining = 0;
  try {
    lastTraining = Number(localStorage.getItem(LAST_TRAINING_KEY)) || 0;
  } catch {}
  const now = Date.now();
  if (now - lastTraining < DAY_MS) return false;

  const { features, labels } = onlineTrainingSet(shadows, now);
  if (features.length < MIN_ONLINE_SAMPLES) return false; // try again when more have finished

  try {
    const model = await trainMetaModel(features, labels);
    if (!model) return false;
    await (model as tf.LayersModel).save(LIVE_MODEL_PATH);
    const winRate = (labels.reduce((a, b) => a + b, 0) / labels.length) * 100;

    const current = loadStoredPromotedLabModel();
    saveStoredPromotedLabModel(
      current
        ? { ...current, promotedAt: new Date(now).toISOString(), hasTrainedModel: true, featureVersion: META_FEATURE_VERSION }
        : {
            // No Lab settings here, so no Lab-tuned trader joins the panel.
            promotedAt: new Date(now).toISOString(),
            datasetName: "Online Learning (Rolling 30-Day Window)",
            accuracyPct: Number(winRate.toFixed(1)),
            winRatePct: Number(winRate.toFixed(1)),
            sharpeRatio: 0,
            totalCandlesEvaluated: 0,
            distilledRulesCount: 1,
            distilledLessons: [
              {
                id: "online-1",
                rule: `Retrained the confidence model on ${features.length} tracked setups from the last 30 days.`,
                regime: "All Regimes",
                action: "Online Learning TFJS Model",
              },
            ],
            hasTrainedModel: true,
            featureVersion: META_FEATURE_VERSION,
          }
    );
    try {
      localStorage.setItem(LAST_TRAINING_KEY, String(now));
    } catch {}
    console.log(`[OnlineLearning] Retrained the confidence model on ${features.length} tracked setups.`);
    window.dispatchEvent(new CustomEvent("nexus-model-trained", { detail: { count: features.length, timestamp: now } }));
    return true;
  } catch (error) {
    console.error("Failed to run continuous online learning", error);
    return false;
  }
}
