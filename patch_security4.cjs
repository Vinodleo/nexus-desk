const fs = require('fs');
let code = fs.readFileSync('src/components/SecurityConsoleModal.tsx', 'utf-8');

// The issue was I removed a closing brace/tag or something in Tab 4.
// Looking closely, there's a missing `</div>` before `{/* Modal Footer */}`
// The original structure was:
//         </div>
//         {/* Modal Footer */}

code = code.replace('          )}\n        {/* Modal Footer */}', '          )}\n        </div>\n        {/* Modal Footer */}');
fs.writeFileSync('src/components/SecurityConsoleModal.tsx', code);
