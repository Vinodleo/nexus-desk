const fs = require('fs');
let code = fs.readFileSync('src/AuthGuard.tsx', 'utf-8');

const oldCheck = `const isAuthorized = currentUser && currentUser.email === "vinoduppar007@gmail.com";
  
  if (!isAuthorized) {
    return <LoginScreen />;
  }`;

const newCheck = `// If there is no user, they MUST login
  if (!currentUser) {
    return <LoginScreen />;
  }
  
  // If there is a user, verify their email
  const isAuthorized = currentUser.email === "vinoduppar007@gmail.com";
  
  if (!isAuthorized) {
    return <LoginScreen />;
  }`;

code = code.replace(oldCheck, newCheck);

fs.writeFileSync('src/AuthGuard.tsx', code);
