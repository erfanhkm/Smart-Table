// Create a test inventory item in the Clover sandbox (one-off setup).
const token = process.env.CLOVER_API_TOKEN;
const mId = process.env.CLOVER_MERCHANT_ID;
if (!token || !mId) { console.error('CLOVER_API_TOKEN and CLOVER_MERCHANT_ID required'); process.exit(2); }
const base = 'https://apisandbox.dev.clover.com';
const r = await fetch(`${base}/v3/merchants/${mId}/items`, {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Test Burger', price: 1299, priceType: 'FIXED' }),
});
const j = await r.json();
console.log(r.status, j.id || JSON.stringify(j).slice(0, 300));
