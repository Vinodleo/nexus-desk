const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

const rogueBlock = `
        {/* 6. Chart Tab View */}
        {activeTab === "chart" && (
          <ChartTab activePositions={activePositions} />
        )}
;`;

const newRenderBlock = `
        {/* 6. Chart Tab View */}
        {activeTab === "chart" && (
          <ChartTab activePositions={activePositions} />
        )}
`;

content = content.replace(/\s*\{\/\* 6\. Chart Tab View \*\/\}[\s\S]*?\}\)\s*;/g, '');

content = content.replace(/<\/main>/, newRenderBlock + '      </main>');

fs.writeFileSync('src/App.tsx', content);
