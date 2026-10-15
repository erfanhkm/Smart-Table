// PENDING payment reconciliation (v0.2 pilot readiness).
//
// When payCheck() charges the POS but our DB transaction rolls back, the
// payments row is left PENDING with the outcome unknown. This job scans for
// stuck PENDING rows and resolves them against the POS (the source of truth).
//
// Matching strategy (H5 fix):
// 1. EXACT: payments.pos_tender_ref (written outside the main transaction the
//    moment the charge succeeds) is matched against the POS tender IDs.
// 2. AMOUNT (fallback only): match by amount, but ONLY when the adapter can
//    actually report tenders, and excluding tender IDs we already recorded.
//    Never mark FAILED on amount-only evidence when the adapter can't report.
//
// Safety rules:
// - Never mark FAILED unless we positively confirmed the POS has no matching
//   payment AND the adapter can report tenders.
// - Each row is locked with FOR UPDATE SKIP LOCKED inside a transaction.
// - One run at a time: pg_advisory_xact_lock.
// - Poison rows back off exponentially (M6 fix).
//
// Run: npx tsx scripts/reconcile.ts  (cron: every 15 min in production)
import { query, withTx } from '../db.js';
import { getCheckPos } from './pos/context.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PosTender } from './pos/types.js';

const STUCK_AFTER_MIN = 10;
const GIVE_UP_AFTER_H = 24;
// Adapters whose getCheckDetail cannot report tenders: amount matching is
// meaningless there, so we never mark FAILED for them.
const NO_TENDER_ADAPTERS = new Set(['shopify']);

interface PendingRow {
  id: string;
  check_id: string;
  amount_cents: number;
  tip_cents: number;
  idempotency_key: string;
  pos_tender_ref: string | null;
  reconcile_attempts: number;
  created_at: string;
}

export async function reconcilePendingPayments(): Promise<{ reconciled: number; failed: number; stillPending: number }> {
  let reconciled = 0, failed = 0, stillPending = 0;

  await withTx(async (client) => {
    // H6 fix: only one reconciler runs at a time (whole-job advisory lock).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('smart-table-reconcile'))`);

    // M6 fix: poison rows back off — a row that errored N times waits 2^N minutes.
    const { rows } = await client.query<PendingRow>(
      `SELECT id, check_id, amount_cents, tip_cents, idempotency_key, pos_tender_ref,
              reconcile_attempts, created_at
       FROM payments
       WHERE status = 'PENDING'
         AND created_at < now() - make_interval(mins => $1)
         AND (last_reconcile_at IS NULL
              OR last_reconcile_at < now() - make_interval(mins => LEAST(2 ^ reconcile_attempts, 240)))
       ORDER BY created_at ASC LIMIT 100
       FOR UPDATE SKIP LOCKED`,
      [STUCK_AFTER_MIN],
    );

    for (const p of rows) {
      try {
        const ageH = (Date.now() - new Date(p.created_at).getTime()) / 3_600_000;
        const ctx = await getCheckPos(p.check_id);
        const detail = await ctx.adapter.getCheckDetail(ctx.checkRef, ctx.token);
        const canSeeTenders = !NO_TENDER_ADAPTERS.has(ctx.posType);

        // Tender IDs we already recorded for this check — never match these again.
        const recordedRefs = await client.query<{ ref: string }>(
          `SELECT COALESCE(external_payment_ref, square_payment_id, pos_tender_ref) AS ref
           FROM payments WHERE check_id = $1 AND status IN ('AUTHORIZED','COMPLETED')`,
          [p.check_id],
        );
        const recordedSet = new Set(recordedRefs.rows.map((r) => r.ref).filter(Boolean));
        const freshTenders = detail.tenders.filter((t: PosTender) => !recordedSet.has(t.id));

        // 1. EXACT match on the stored POS reference.
        let matched: PosTender | undefined;
        if (p.pos_tender_ref) {
          matched = detail.tenders.find((t: PosTender) => t.id === p.pos_tender_ref);
        }
        // 2. Amount fallback — only when the adapter reports tenders and we
        //    have a real (non-zero) amount to match on.
        if (!matched && canSeeTenders && p.amount_cents > 0) {
          matched = freshTenders.find((t: PosTender) => t.amountCents === p.amount_cents);
        }

        if (matched) {
          const closed = detail.remainingCents <= 0;
          // H6 fix: guard the UPDATE with AND status='PENDING'.
          const upd = await client.query(
            `UPDATE payments SET status = $2, external_payment_ref = COALESCE(external_payment_ref, $3),
               remaining_after_cents = $4, check_state = $5, currency = $6,
               reconcile_attempts = 0, last_reconcile_at = now()
             WHERE id = $1 AND status = 'PENDING'`,
            [p.id, closed ? 'COMPLETED' : 'AUTHORIZED', matched.id,
             Math.max(0, detail.remainingCents), closed ? 'COMPLETED' : 'OPEN', detail.currency],
          );
          if ((upd.rowCount ?? 0) === 0) {
            stillPending++; // someone else resolved it; skip
            continue;
          }
          if (closed) {
            await client.query(`UPDATE checks SET state='COMPLETED' WHERE id=$1`, [p.check_id]);
            const chk = await client.query<{ table_id: string | null }>(
              `SELECT table_id FROM checks WHERE id=$1`, [p.check_id]);
            const tableId = chk.rows[0]?.table_id;
            if (tableId) {
              await client.query(`UPDATE tables SET state='PAID' WHERE id=$1`, [tableId]);
              await client.query(`INSERT INTO events(id, table_id, check_id, type) VALUES($1,$2,$3,'paid')`,
                [randomUUID(), tableId, p.check_id]);
            }
          }
          console.log(`[reconcile] ${p.idempotency_key}: POS tender ${matched.id} -> ${closed ? 'COMPLETED' : 'AUTHORIZED'}`);
          reconciled++;
        } else if (ageH > GIVE_UP_AFTER_H && canSeeTenders) {
          // H5 fix: FAILED only after a POSITIVE check (adapter reports tenders
          // and none matches). Never FAILED when we can't see tenders.
          await client.query(
            `UPDATE payments SET status='FAILED', reconcile_attempts = 0, last_reconcile_at = now()
             WHERE id=$1 AND status='PENDING'`,
            [p.id],
          );
          console.log(`[reconcile] ${p.idempotency_key}: no POS tender after ${ageH.toFixed(1)}h -> FAILED`);
          failed++;
        } else {
          await client.query(
            `UPDATE payments SET reconcile_attempts = reconcile_attempts + 1, last_reconcile_at = now()
             WHERE id = $1`,
            [p.id],
          );
          stillPending++;
        }
      } catch (e) {
        // M6 fix: record the error and back off; the row ages out of the batch.
        await client.query(
          `UPDATE payments SET reconcile_attempts = reconcile_attempts + 1,
             last_reconcile_error = $2, last_reconcile_at = now() WHERE id = $1`,
          [p.id, e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500)],
        ).catch(() => undefined);
        console.error(`[reconcile] ${p.idempotency_key}: error`, e instanceof Error ? e.message : e);
        stillPending++;
      }
    }
  });
  return { reconciled, failed, stillPending };
}

// H6 fix: compare import.meta.url against the entry file (like index.ts does).
// The old process.argv[1]?.endsWith('reconcile.ts') matched BOTH this file and
// scripts/reconcile.ts, starting two concurrent runs.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  reconcilePendingPayments()
    .then((r) => {
      console.log(`RECONCILE DONE: ${r.reconciled} reconciled, ${r.failed} failed, ${r.stillPending} still pending`);
      process.exit(0);
    })
    .catch((e) => {
      console.error('RECONCILE FAILED:', e);
      process.exit(1);
    });
}
