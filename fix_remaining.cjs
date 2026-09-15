const fs = require('fs');

function replace(file, find, replace) {
  let c = fs.readFileSync(file, 'utf-8');
  c = c.split(find).join(replace);
  fs.writeFileSync(file, c);
}

replace('src/components/ApprovalModal.tsx', '+$', '+₹');
replace('src/components/LabTab.tsx', '+$', '+₹');
replace('src/components/TradingViewStage.tsx', '""}$', '""}₹');
replace('src/components/ApprovalQueue.tsx', '+$', '+₹');
replace('src/components/BookTab.tsx', '+$', '+₹');

// App.tsx
let appC = fs.readFileSync('src/App.tsx', 'utf-8');
appC = appC.replace('@ $$', '@ ₹$');
fs.writeFileSync('src/App.tsx', appC);

