// Verify QR ordering: getMenu + createCheck against the Shopify dev store.
import { shopifyAdapter } from '../src/services/pos/shopify.js';

const token = process.env.SHOPIFY_ADMIN_TOKEN;
const shop = process.env.SHOPIFY_SHOP;
if (!token || !shop) {
  console.error('SHOPIFY_ADMIN_TOKEN and SHOPIFY_SHOP required');
  process.exit(2);
}

const menu = await shopifyAdapter.getMenu!(shop, token);
console.log(`MENU: ${menu.length} items`);
for (const m of menu.slice(0, 5)) {
  console.log(`  - ${m.name}: ${m.priceCents} ${m.currency}`);
}

if (menu.length === 0) {
  console.log('No products — add products in the Shopify admin to test ordering.');
  process.exit(0);
}

const { checkId } = await shopifyAdapter.createCheck!({
  locationRef: shop,
  items: [{ menuItemId: menu[0].id, quantity: 1, note: null }],
  tableLabel: 'T-TEST',
  idempotencyKey: `qr-order-${Date.now()}`,
  token,
});
console.log(`DRAFT ORDER CREATED: ${checkId}`);

const detail = await shopifyAdapter.getCheckDetail(checkId, token);
console.log(`DETAIL: total=${detail.totalCents} ${detail.currency}, state=${detail.state}`);
console.log(`ITEMS: ${detail.items.map((i) => `${i.quantity}x ${i.name}`).join(', ')}`);
console.log('SHOPIFY QR ORDER VERIFY PASS');
