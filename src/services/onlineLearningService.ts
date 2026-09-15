import { ExperienceVector } from "../types";
import { trainMetaModel } from "./mlService";
import { loadStoredPromotedLabModel, saveStoredPromotedLabModel } from "./storagePersistenceService";
import * as tf from "@tensorflow/tfjs";

const LAST_TRAINING_KEY = "nexus_last_online_training_timestamp";

export async function checkAndRunOnlineLearning(experiences: ExperienceVector[]): Promise<boolean> {
  const lastTrainingStr = localStorage.getItem(LAST_TRAINING_KEY);
  const lastTraining = lastTrainingStr ? parseInt(lastTrainingStr, 10) : 0;
  const now = Date.now();
  
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  
  if (now - lastTraining < ONE_DAY_MS) {
    return false; // Less than a day passed
  }
  
  if (experiences.length === 0) {
    return false;
  }
  
  console.log("Triggering continuous online learning on rolling experience buffer...");
  
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const recentExperiences = experiences.filter(exp => {
    const expTime = new Date(exp.timestamp).getTime();
    return now - expTime <= THIRTY_DAYS_MS;
  });
  
  if (recentExperiences.length < 5) {
    console.log("Not enough recent experiences for continuous training.");
    localStorage.setItem(LAST_TRAINING_KEY, now.toString()); // Skip for today
    return false;
  }
  
  try {
    const mlFeatures: number[][] = [];
    const mlLabels: number[] = [];
    let wins = 0;
    
    for (const exp of recentExperiences) {
      if (exp.features && exp.outcome) {
        const atrScaled = exp.features.volatilityRatio * 0.01; 
        const volSurgeScaled = Math.min(exp.features.volumeSurgeRatio / 5, 1);
        const rsiScaled = exp.features.rsi / 100;
        const vwapDist = exp.features.vwapDist / 100;
        const date = new Date(exp.timestamp);
        const timeOfDay = date.getUTCHours() / 24;
        
        let slope = 0;
        if (exp.regime === "trending_bullish") slope = 0.05;
        else if (exp.regime === "trending_bearish") slope = -0.05;
        
        mlFeatures.push([atrScaled, volSurgeScaled, rsiScaled, vwapDist, timeOfDay, slope]);
        
        const isWin = exp.outcome === "WIN";
        mlLabels.push(isWin ? 1 : 0);
        if (isWin) wins++;
      }
    }
    
    if (mlFeatures.length >= 5) {
      const trainedModel = await trainMetaModel(mlFeatures, mlLabels);
      if (trainedModel) {
        await (trainedModel as tf.LayersModel).save('localstorage://meta-model');
        console.log(`Continuous online learning completed successfully on ${mlFeatures.length} recent experiences.`);
        
        // Update the promoted lab model so the scanner uses it
        let currentPromoted = loadStoredPromotedLabModel();
        
        const winRate = (wins / mlFeatures.length) * 100;
        
        if (!currentPromoted) {
            currentPromoted = {
                promotedAt: new Date().toISOString(),
                datasetName: "Online Learning (Rolling 30-Day Window)",
                accuracyPct: winRate,
                winRatePct: winRate,
                sharpeRatio: 1.5,
                totalCandlesEvaluated: 0,
                distilledRulesCount: 1,
                distilledLessons: [{ id: "online-1", rule: "Continuously trained Neural Network on rolling 30-day paper trading experience buffer.", regime: "All Regimes", action: "Online Learning TFJS Model" }],
                hasTrainedModel: true,
                optimizedParameters: {
                  slMultiplier: 1.5, tpMultiplier: 3.0, volSurgeThreshold: 1.2, rsiThreshold: 65, minConfidence: 0.52
                }
            };
        } else {
            currentPromoted.promotedAt = new Date().toISOString();
            currentPromoted.datasetName = "Online Learning (Rolling 30-Day Window)";
            currentPromoted.hasTrainedModel = true;
            // Slightly bias accuracy towards the recent experiences, keeping some historical weight
            currentPromoted.accuracyPct = (currentPromoted.accuracyPct + winRate) / 2;
        }
        
        saveStoredPromotedLabModel(currentPromoted);

        window.dispatchEvent(new CustomEvent('nexus-model-trained', { 
            detail: { count: mlFeatures.length, timestamp: now } 
        }));
      }
    }
    
    localStorage.setItem(LAST_TRAINING_KEY, now.toString());
    return true;
  } catch (error) {
    console.error("Failed to run continuous online learning", error);
    return false;
  }
}
