// Sandbox verification for the Clover adapter (v0.3).
// Usage:
//   CLOVER_ENV=sandbox CLOVER_TEST_MERCHANT_ID=<mId> CLOVER_SANDBOX_TOKEN=<token> \
//     npx tsx scripts/verify-clover.ts
// The token is a test-merchant API token from the Clover developer dashboard
// (sandbox). It proves, against the LIVE sandbox:
//   [V1] order.state enum values present in the data
//   [V2] whether server-side state filtering is needed (we filter client-side)
//   [V3] lineItems unitQty/price semantics
//   [V4] POST payment body shape acceptance
//   [V5] currency field presence
// This script is READ-ONLY except for an optional payment probe, which is
// off by default (set PROBE_PAYMENT=1 to enable on a test order you own).
import { getAdapter } from '../src/services/pos/registry.js';

const merchantId = process.env.CLOVER_TEST_MERCHANT_ID ?? '';
const token = process.env.CLOVER_SANDBOX_TOKEN ?? '';
if (!merchantId || !token) {
  console.error('Set CLOVER_TEST_MERCHANT_ID and CLOVER_SANDBOX_TOKEN first.');
  process.exit(1);
}

const adapter = getAdapter('clover');
console.log('posType:', adapter.posType);

const open = await adapter.listOpenChecks(merchantId, token);
console.log(`\nlistOpenChecks -> ${open.length} open check(s)`);
for (const o of open.slice(0, 5)) {
  console.log(`  - ${o.id} | ${o.displayLabel} | total=${o.totalCents} remaining=${o.remainingCents} ${o.currency} | opened=${o.openedAt}`);
}

if (open.length > 0) {
  const first = open[0];
  const detail = await adapter.getCheckDetail(`${merchantId}:${first.id}`, token);
  console.log(`\ngetCheckDetail(${first.id}):`);
  console.log(`  state=${detail.state} total=${detail.totalCents} remaining=${detail.remainingCents} currency=${detail.currency}`);
  console.log(`  items (${detail.items.length}):`);
  for (const i of detail.items.slice(0, 5)) {
    console.log(`    - ${i.quantity} x ${i.name} = ${i.amountCents}`);
  }
  console.log(`  tenders (${detail.tenders.length}):`);
  for (const t of detail.tenders.slice(0, 5)) {
    console.log(`    - ${t.type}: ${t.amountCents} (id ${t.id.slice(0, 12)}…)`);
  }
} else {
  console.log('\nNo open checks in the sandbox merchant — create a test order in the sandbox dashboard, then re-run.');
}

if (process.env.PROBE_PAYMENT === '1' && open.length > 0) {
  const target = open[0];
  const res = await adapter.recordExternalPayment(
    `${merchantId}:${target.id}`,
    100,
    target.currency,
    'TEST_CASH',
    `verify-${Date.now()}`,
    token,
  );
  console.log(`\nrecordExternalPayment probe -> paymentId=${res.paymentId} remaining=${res.remainingCents}`);
} else {
  console.log('\nPayment probe skipped (set PROBE_PAYMENT=1 to enable).');
}

console.log('\nDone. Paste this output into the v0.3 notes as the verification record.');
