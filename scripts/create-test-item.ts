// Create a test catalog item in the Square sandbox (one-off setup).
const token = process.env.SQUARE_ACCESS_TOKEN;
if (!token) { console.error('SQUARE_ACCESS_TOKEN required'); process.exit(2); }
const r = await fetch('https://connect.squareupsandbox.com/v2/catalog/object', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Square-Version': '2024-01-18' },
  body: JSON.stringify({
    idempotency_key: 'test-item-' + Date.now(),
    object: {
      type: 'ITEM',
      id: '#test-burger',
      item_data: {
        name: 'Test Burger',
        description: 'QR ordering test item',
        variations: [{
          type: 'ITEM_VARIATION',
          id: '#test-burger-var',
          item_variation_data: {
            name: 'Regular',
            pricing_type: 'FIXED_PRICING',
            price_money: { amount: 1299, currency: 'USD' },
          },
        }],
      },
    },
  }),
});
const j = await r.json();
console.log(r.status, j.catalog_object?.id || JSON.stringify(j).slice(0, 300));
