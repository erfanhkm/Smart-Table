// Create a test product in the Shopify dev store (one-off setup).
const token = process.env.SHOPIFY_ADMIN_TOKEN;
const shop = process.env.SHOPIFY_SHOP;
if (!token || !shop) { console.error('SHOPIFY_ADMIN_TOKEN and SHOPIFY_SHOP required'); process.exit(2); }
const r = await fetch(`https://${shop}/admin/api/2026-07/products.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    product: {
      title: 'Test Burger',
      body_html: 'QR ordering test product',
      product_type: 'Food',
      status: 'active',
      variants: [{ price: '12.99', inventory_management: null }],
    },
  }),
});
const j = await r.json();
console.log(r.status, j.product?.id || JSON.stringify(j).slice(0, 300));
