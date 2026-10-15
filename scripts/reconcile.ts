// Run the PENDING payment reconciler (see src/services/reconcile.ts).
// Cron: every 15 minutes in production.
import { reconcilePendingPayments } from '../src/services/reconcile.js';

const r = await reconcilePendingPayments();
console.log(`RECONCILE DONE: ${r.reconciled} reconciled, ${r.failed} failed, ${r.stillPending} still pending`);
process.exit(0);
