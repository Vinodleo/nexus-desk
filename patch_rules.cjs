const fs = require('fs');
let code = fs.readFileSync('firestore.rules', 'utf-8');

const newRule = `
      match /credentials/{credentialId} {
        allow read: if isSignedIn() && request.auth.uid == userId;
        allow create: if isSignedIn() && request.auth.uid == userId && isValidId(credentialId);
        allow update: if isSignedIn() && request.auth.uid == userId && isValidId(credentialId);
        allow delete: if isSignedIn() && request.auth.uid == userId;
      }
`;

code = code.replace(
  "match /closedTrades/{tradeId} {",
  newRule + "      match /closedTrades/{tradeId} {"
);

fs.writeFileSync('firestore.rules', code);
