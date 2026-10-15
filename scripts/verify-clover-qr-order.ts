// Verify QR ordering: getMenu + createCheck against the Clover sandbox.
import { cloverAdapter } from '../src/services/pos/clover.js';

const token = process.env.CLOVER_API_TOKEN;
const merchantId = process.env.CLOVER_MERCHANT_ID;
if (!token || !merchantId) {
  console.error('CLOVER_API_TOKEN and CLOVER_MERCHANT_ID required');
  process.exit(2);
}

const menu = await cloverAdapter.getMenu!(merchantId, token);
console.log(`MENU: ${menu.length} items`);
for (const m of menu.slice(0, 5)) {
  console.log(`  - ${m.name}: ${m.priceCents} ${m.currency}`);
}

if (menu.length === 0) {
  console.log('No inventory items — add items in the Clover dashboard to test ordering.');
  process.exit(0);
}

const { checkId } = await cloverAdapter.createCheck!({
  locationRef: merchantId,
  items: [{ menuItemId: menu[0].id, quantity: 1, note: null }],
  tableLabel: 'T-TEST',
  idempotencyKey: `qr-order-${Date.now()}`,
  token,
});
console.log(`ORDER CREATED: ${checkId}`);

const detail = await cloverAdapter.getCheckDetail(checkId, token);
console.log(`DETAIL: total=${detail.totalCents} ${detail.currency}, state=${detail.state}`);
console.log(`ITEMS: ${detail.items.map((i) => `${i.quantity}x ${i.name}`).join(', ')}`);
console.log('CLOVER QR ORDER VERIFY PASS');
