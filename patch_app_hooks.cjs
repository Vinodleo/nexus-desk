const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

// I will extract the early return logic out of App and wrap it in a AuthGuard component in main.tsx instead.

// Remove the auth guard from App
const oldAuthGuard = `
  if (loading) {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-emerald-500 font-mono">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs tracking-widest uppercase">Booting Nexus Kernel...</p>
        </div>
      </div>
    );
  }

  // Security Gate: Restrict to authorized admin
  const isAuthorized = currentUser && currentUser.email === "vinoduppar007@gmail.com";
  
  if (!isAuthorized) {
    return <LoginScreen />;
  }

`;

code = code.replace(oldAuthGuard, "\n");

fs.writeFileSync('src/App.tsx', code);
