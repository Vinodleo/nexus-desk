const fs = require('fs');
let code = fs.readFileSync('src/services/storagePersistenceService.ts', 'utf-8');

const newCode = `
import { auth, db } from "./firebase";
import { doc, getDoc, setDoc, collection, getDocs, writeBatch } from "firebase/firestore";

export async function syncToFirebase(userId: string) {
  try {
    const userRef = doc(db, "users", userId);
    
    const stats = loadStoredStats();
    const capital = loadStoredCapital();
    const accuracy = loadStoredModelAccuracy();
    const promotedModel = loadStoredPromotedLabModel();
    const dailyTelemetry = loadDailySampleTelemetry();

    await setDoc(userRef, {
      uid: userId,
      email: auth.currentUser?.email || "",
      createdAt: new Date().toISOString(),
      ...stats,
      ...capital,
      accuracyPct: accuracy.accuracyPct || 0,
      promotedLabModel: promotedModel || null,
      dailyTelemetry: dailyTelemetry || null
    }, { merge: true });

    const experiences = loadStoredExperiences();
    if (experiences.length > 0) {
      const expBatch = writeBatch(db);
      experiences.slice(0, 450).forEach(exp => {
        const expRef = doc(db, "users", userId, "experiences", exp.id);
        expBatch.set(expRef, { ...exp, userId });
      });
      await expBatch.commit();
    }

    const trades = loadStoredClosedTrades();
    if (trades.length > 0) {
      const tradesBatch = writeBatch(db);
      trades.slice(0, 450).forEach(trade => {
        const tradeRef = doc(db, "users", userId, "closedTrades", trade.id);
        tradesBatch.set(tradeRef, { ...trade, userId });
      });
      await tradesBatch.commit();
    }
    
    console.log("Successfully synced to Firebase cloud.");
  } catch (err) {
    console.error("Firebase sync error", err);
  }
}

export async function syncFromFirebase(userId: string): Promise<boolean> {
  try {
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);
    
    if (userSnap.exists()) {
      const data = userSnap.data();
      
      saveStoredStats({
        selfApprovedCount: data.selfApprovedCount || 0,
        selfApprovedWins: data.selfApprovedWins || 0,
        selfApprovedLosses: data.selfApprovedLosses || 0,
        lastUpdated: data.lastUpdated || new Date().toISOString()
      });
      
      saveStoredCapital({
        equity: data.equity || 100000,
        cash: data.cash || 100000,
        dailyRealizedPnl: data.dailyRealizedPnl || 0
      });
      
      if (data.accuracyPct) {
        saveStoredModelAccuracy({
          accuracyPct: data.accuracyPct,
          datasetName: "Cloud Synced",
          winRatePct: 0,
          sharpeRatio: 0,
          totalCandlesEvaluated: 0,
          lastUpdated: data.lastUpdated
        });
      }
      
      if (data.promotedLabModel) {
        saveStoredPromotedLabModel(data.promotedLabModel);
      }
      
      if (data.dailyTelemetry) {
        saveDailySampleTelemetry(data.dailyTelemetry);
      }
    }

    const expSnap = await getDocs(collection(db, "users", userId, "experiences"));
    if (!expSnap.empty) {
      const exps = expSnap.docs.map(d => d.data() as ExperienceVector);
      saveStoredExperiences(exps);
    }

    const tradesSnap = await getDocs(collection(db, "users", userId, "closedTrades"));
    if (!tradesSnap.empty) {
      const trades = tradesSnap.docs.map(d => d.data() as HistoricalTrade);
      saveStoredClosedTrades(trades);
    }
    
    return true;
  } catch (err) {
    console.error("Firebase load error", err);
    return false;
  }
}
`;

code = code + newCode;
fs.writeFileSync('src/services/storagePersistenceService.ts', code);
