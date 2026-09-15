const fs = require('fs');

// Patch App.tsx
let appCode = fs.readFileSync('src/App.tsx', 'utf-8');
appCode = appCode.replace('import { NetworkTab } from "./components/NetworkTab";\n', '');
appCode = appCode.replace(
  '        {/* 6. Network Tab View */}\n        {activeTab === "network" && (\n          <NetworkTab />\n        )}\n\n',
  ''
);
fs.writeFileSync('src/App.tsx', appCode);

// Patch BottomNavBar.tsx
let navCode = fs.readFileSync('src/components/BottomNavBar.tsx', 'utf-8');
navCode = navCode.replace(', Globe', '');
navCode = navCode.replace(' | "network"', '');
navCode = navCode.replace('    { id: "network", label: "Network", icon: Globe },\n', '');
navCode = navCode.replace('grid-cols-6', 'grid-cols-5');
fs.writeFileSync('src/components/BottomNavBar.tsx', navCode);

// Delete NetworkTab.tsx
if (fs.existsSync('src/components/NetworkTab.tsx')) {
  fs.unlinkSync('src/components/NetworkTab.tsx');
}
