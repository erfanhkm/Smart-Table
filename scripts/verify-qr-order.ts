// Verify QR ordering: getMenu + createCheck against the Square sandbox.
import { squareAdapter } from '../src/services/pos/square.js';

const token = process.env.SQUARE_ACCESS_TOKEN;
const locationId = process.env.SQUARE_LOCATION_ID;
if (!token || !locationId) {
  console.error('SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID required');
  process.exit(2);
}

const menu = await squareAdapter.getMenu!(locationId, token);
console.log(`MENU: ${menu.length} items`);
for (const m of menu.slice(0, 5)) {
  console.log(`  - ${m.name}: ${m.priceCents} ${m.currency}`);
}

if (menu.length === 0) {
  console.log('No catalog items — add items in the Square dashboard to test ordering.');
  process.exit(0);
}

const { checkId } = await squareAdapter.createCheck!({
  locationRef: locationId,
  items: [{ menuItemId: menu[0].id, quantity: 1, note: null }],
  tableLabel: 'T-TEST',
  idempotencyKey: `qr-order-${Date.now()}`,
  token,
});
console.log(`ORDER CREATED: ${checkId}`);

const detail = await squareAdapter.getCheckDetail(checkId, token);
console.log(`DETAIL: total=${detail.totalCents} ${detail.currency}, state=${detail.state}`);
console.log(`REF: ${detail.items.map((i) => `${i.quantity}x ${i.name}`).join(', ')}`);
console.log('QR ORDER VERIFY PASS');
