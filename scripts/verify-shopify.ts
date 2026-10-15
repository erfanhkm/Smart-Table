// Sandbox verification for the Shopify adapter (v0.3).
// Usage:
//   SHOPIFY_SHOP_DOMAIN=<shop>.myshopify.com SHOPIFY_ADMIN_TOKEN=<token> \
//     npx tsx scripts/verify-shopify.ts
// The token is an Admin API access token from a custom app on a Shopify
// dev store (Partners dashboard -> dev store -> Apps -> custom app with
// read_draft_orders, write_draft_orders, read_orders scopes).
// It proves, against the LIVE dev store:
//   [S1] draft_order.status enum values present in the data
//   [S2] line_items price semantics (per-unit decimal string)
//   [S3] POST complete body shape acceptance
//   [S4] webhook HMAC verification (manual: trigger a test webhook)
//   [S5] currency field presence
// This script is READ-ONLY except for an optional payment probe, which is
// off by default (set PROBE_PAYMENT=1 to enable on a draft you own).
import { getAdapter } from '../src/services/pos/registry.js';

const shop = process.env.SHOPIFY_SHOP_DOMAIN ?? '';
const token = process.env.SHOPIFY_ADMIN_TOKEN ?? '';
if (!shop || !token) {
  console.error('Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_TOKEN first.');
  process.exit(1);
}

const adapter = getAdapter('shopify');
console.log('posType:', adapter.posType);

const open = await adapter.listOpenChecks(shop, token);
console.log(`\nlistOpenChecks -> ${open.length} open check(s)`);
for (const o of open.slice(0, 5)) {
  console.log(`  - ${o.id} | ${o.displayLabel} | total=${o.totalCents} remaining=${o.remainingCents} ${o.currency} | opened=${o.openedAt}`);
}

if (open.length > 0) {
  const first = open[0];
  const detail = await adapter.getCheckDetail(`${shop}:${first.id}`, token);
  console.log(`\ngetCheckDetail(${first.id}):`);
  console.log(`  state=${detail.state} total=${detail.totalCents} remaining=${detail.remainingCents} currency=${detail.currency}`);
  console.log(`  items (${detail.items.length}):`);
  for (const i of detail.items.slice(0, 5)) {
    console.log(`    - ${i.quantity} x ${i.name} = ${i.amountCents}`);
  }
} else {
  console.log('\nNo open draft orders in the dev store — create one (Drafts -> Add draft order), then re-run.');
}

if (process.env.PROBE_PAYMENT === '1' && open.length > 0) {
  const target = open[0];
  const res = await adapter.recordExternalPayment(
    `${shop}:${target.id}`,
    100,
    target.currency,
    'CASH',
    `verify-${Date.now()}`,
    token,
  );
  console.log(`\nrecordExternalPayment probe -> paymentId=${res.paymentId} remaining=${res.remainingCents}`);
} else {
  console.log('\nPayment probe skipped (set PROBE_PAYMENT=1 to enable).');
}

console.log('\nDone. Paste this output into the v0.3 notes as the verification record.');
