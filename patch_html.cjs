const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf-8');

const swClear = `
    <script>
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(registrations) {
          for(let registration of registrations) {
            registration.unregister();
          }
        });
      }
    </script>
`;

code = code.replace('<script type="module" src="/src/main.tsx"></script>', swClear + '    <script type="module" src="/src/main.tsx"></script>');

fs.writeFileSync('index.html', code);
