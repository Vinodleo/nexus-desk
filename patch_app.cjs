const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

// import ChartTab
content = content.replace(/import \{ LabTab \} from "\.\/components\/LabTab";/, 'import { LabTab } from "./components/LabTab";\nimport { ChartTab } from "./components/ChartTab";');

// render ChartTab
const chartTabStr = `
        {/* 6. Chart Tab View */}
        {activeTab === "chart" && (
          <ChartTab activePositions={activePositions} />
        )}
`;

content = content.replace(/\{activeTab === "lab" && \([\s\S]*?\}\)/, (match) => {
    return match + chartTabStr;
});

fs.writeFileSync('src/App.tsx', content);
