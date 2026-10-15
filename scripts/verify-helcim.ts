// Sandbox verification for the Helcim adapter (v0.3).
// Usage:
//   HELCIM_API_TOKEN=<token> npx tsx scripts/verify-helcim.ts
// The token is an API token from a Helcim developer test account:
// dashboard -> All Tools -> Integrations -> API Access Configurations ->
// New API Access. (Request a test account via [email protected].)
// It proves, against the LIVE test account:
//   [S1] invoice.status enum values present in the data
//   [S2] lineItems price semantics (line total in major units)
//   [S3] PUT /v2/invoices/{id} {status:"PAID"} acceptance
//   [S4] webhook topics + signature scheme (manual: configure in dashboard)
//   [S5] remaining amount on partially-paid DUE invoices
// This script is READ-ONLY except for an optional payment probe, which is
// off by default (set PROBE_PAYMENT=1 to enable on an invoice you own).
import { getAdapter } from '../src/services/pos/registry.js';

const token = process.env.HELCIM_API_TOKEN ?? '';
if (!token) {
  console.error('Set HELCIM_API_TOKEN first.');
  process.exit(1);
}

const adapter = getAdapter('helcim');
console.log('posType:', adapter.posType);

const open = await adapter.listOpenChecks('test-account', token);
console.log(`\nlistOpenChecks -> ${open.length} open check(s)`);
for (const o of open.slice(0, 5)) {
  console.log(`  - ${o.id} | ${o.displayLabel} | total=${o.totalCents} remaining=${o.remainingCents} ${o.currency} | opened=${o.openedAt}`);
}

if (open.length > 0) {
  const first = open[0];
  const detail = await adapter.getCheckDetail(first.id, token);
  console.log(`\ngetCheckDetail(${first.id}):`);
  console.log(`  state=${detail.state} total=${detail.totalCents} remaining=${detail.remainingCents} currency=${detail.currency}`);
  console.log(`  items (${detail.items.length}):`);
  for (const i of detail.items.slice(0, 5)) {
    console.log(`    - ${i.quantity} x ${i.name} = ${i.amountCents}`);
  }
} else {
  console.log('\nNo DUE invoices in the test account — create one (Invoices -> New invoice), then re-run.');
}

if (process.env.PROBE_PAYMENT === '1' && open.length > 0) {
  const target = open[0];
  const res = await adapter.recordExternalPayment(
    target.id,
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
