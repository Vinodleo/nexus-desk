const fs = require('fs');
let code = fs.readFileSync('src/services/storagePersistenceService.ts', 'utf-8');

// I am adding saveExchangeKeys and loadExchangeKeys functions
const newFunctions = `

export async function saveExchangeKeys(userId: string, exchangeType: string, apiKey: string, apiSecret: string) {
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
}

export async function loadExchangeKeys(userId: string) {
  try {
    const keysRef = doc(db, "users", userId, "credentials", "exchangeKeys");
    const snap = await getDoc(keysRef);
    if (snap.exists()) {
      return snap.data();
    }
    return null;
  } catch (err) {
    console.error("Failed to load exchange keys from Firebase:", err);
    return null;
  }
}
`;

code = code + newFunctions;
fs.writeFileSync('src/services/storagePersistenceService.ts', code);
