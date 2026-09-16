const https = require('https');
https.get('https://public.coindcx.com/exchange/ticker', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const usdt = parsed.filter(p => p.market.includes('USDT') && p.market.includes('BTC'));
      console.log('USDT Markets:', usdt.map(u => u.market));
    } catch (e) {}
  });
});
