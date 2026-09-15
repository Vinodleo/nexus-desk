const fs = require('fs');
let code = fs.readFileSync('src/components/QueueTab.tsx', 'utf-8');

// The recently approved section
code = code.replace(/@ \$\{p\.setup\.entryPrice\.toFixed\(2\)\}/g, '@ ₹${p.setup.entryPrice.toFixed(2)}');

// The active queue tickets section (Size, Stop, Target values)
code = code.replace(/\$\{Math\.round\(sizeDollars\)\.toLocaleString\(\)\}/g, '₹${Math.round(sizeDollars).toLocaleString()}');
code = code.replace(/\$\{proposal\.setup\.stopLoss\.toFixed\(2\)\}/g, '₹${proposal.setup.stopLoss.toFixed(2)}');
code = code.replace(/\$\{proposal\.setup\.takeProfit\.toFixed\(2\)\}/g, '₹${proposal.setup.takeProfit.toFixed(2)}');

fs.writeFileSync('src/components/QueueTab.tsx', code);
