const fs = require('fs');
let c = fs.readFileSync('src/App.tsx', 'utf-8');
c = c.replace(/}\$\$\{/g, '}₹${');
c = c.replace(/ \$\$\{/g, ' ₹${');
c = c.replace(/\+\$\$\{/g, '+₹${');
c = c.replace(/-\$\$\{/g, '-₹${');
c = c.replace(/\(\$\$\{/g, '(₹${');
fs.writeFileSync('src/App.tsx', c);
console.log('done');
