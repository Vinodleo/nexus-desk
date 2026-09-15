const fs = require('fs');
let code = fs.readFileSync('src/services/storagePersistenceService.ts', 'utf-8');

const oldSave = `export async function saveExchangeKeys(userId: string, exchangeType: string, apiKey: string, apiSecret: string) {
  try {
    const keysRef = doc(db, "users", userId, "credentials", "exchangeKeys");
    await setDoc(keysRef, {
      exchangeType,
      apiKey,
      apiSecret, // In a real app, this should be properly encrypted before sending to Firestore
      updatedAt: new Date().toISOString()
    }, { merge: true });
    return true;
  } catch (err) {
    console.error("Failed to save exchange keys to Firebase:", err);
    return false;
  }
}`;

const newSave = `export async function saveExchangeKeys(userId: string, exchangeId: string, apiKey: string, apiSecret: string) {
  try {
    const keysRef = doc(db, "users", userId, "credentials", "exchangeKeys");
    const updatePayload = {
      [exchangeId]: {
        apiKey,
        apiSecret,
        updatedAt: new Date().toISOString()
      }
    };
    await setDoc(keysRef, updatePayload, { merge: true });
    return true;
  } catch (err) {
    console.error("Failed to save exchange keys to Firebase:", err);
    return false;
  }
}`;

code = code.replace(oldSave, newSave);
fs.writeFileSync('src/services/storagePersistenceService.ts', code);
