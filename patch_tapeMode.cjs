const fs = require('fs');
let appContent = fs.readFileSync('src/App.tsx', 'utf-8');

appContent = appContent.replace(
  'const [tapeMode, setTapeMode] = useState<"SIMULATED TAPE" | "LIVE TAPE">(\n    "SIMULATED TAPE"\n  );',
  'const [tapeMode, setTapeMode] = useState<"SIMULATED TAPE" | "LIVE TAPE">(\n    "LIVE TAPE"\n  );'
);

appContent = appContent.replace(
  'const [tapeMode, setTapeMode] = useState<"SIMULATED TAPE" | "LIVE TAPE">(\n    "SIMULATED TAPE"\r\n  );',
  'const [tapeMode, setTapeMode] = useState<"SIMULATED TAPE" | "LIVE TAPE">(\n    "LIVE TAPE"\n  );'
);

fs.writeFileSync('src/App.tsx', appContent);
console.log('patched tapeMode');
