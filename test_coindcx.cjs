const https = require('https');

https.get('https://public.coindcx.com/exchange/ticker', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const btcInr = parsed.find(p => p.market === 'BTCINR');
      console.log('CoinDCX Public BTCINR Ticker:', btcInr);
    } catch (e) {
      console.error('Error parsing:', e.message);
    }
  });
}).on('error', (e) => {
  console.error(e);
});
