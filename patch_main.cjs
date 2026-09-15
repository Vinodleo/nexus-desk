const fs = require('fs');
let code = fs.readFileSync('src/main.tsx', 'utf-8');

const importAuthGuard = `import { AuthGuard } from "./AuthGuard";\n`;

code = code.replace('import { ErrorBoundary } from "./ErrorBoundary";', 'import { ErrorBoundary } from "./ErrorBoundary";\n' + importAuthGuard);

code = code.replace('<App />', '<AuthGuard><App /></AuthGuard>');

fs.writeFileSync('src/main.tsx', code);
