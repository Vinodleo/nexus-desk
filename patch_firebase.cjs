const fs = require('fs');
let content = fs.readFileSync('src/services/firebase.ts', 'utf-8');

// Replace getFirestore with initializeFirestore
content = content.replace('getFirestore, Firestore', 'initializeFirestore, getFirestore, Firestore');

// Replace db init
content = content.replace(
  /export const db: Firestore = firebaseConfig\.firestoreDatabaseId[\s\S]*?\: getFirestore\(app\);/g,
  `export const db: Firestore = firebaseConfig.firestoreDatabaseId
  ? initializeFirestore(app, { experimentalForceLongPolling: true }, firebaseConfig.firestoreDatabaseId)
  : initializeFirestore(app, { experimentalForceLongPolling: true });`
);

fs.writeFileSync('src/services/firebase.ts', content);
console.log("Patched firebase.ts");
