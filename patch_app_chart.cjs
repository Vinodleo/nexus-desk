const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

content = content.replace(/import \{ ChartTab \} from "\.\/components\/ChartTab";\n/, "");
content = content.replace(/\s*\{\/\* 6\. Chart Tab View \*\/\}[\s]*\{activeTab === "chart" && \([\s]*<ChartTab activePositions=\{activePositions\} \/>[\s]*\)\}/g, "");

fs.writeFileSync('src/App.tsx', content);
