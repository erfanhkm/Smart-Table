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
// - One run at a time: session-level advisory try-lock (F-6); each row
//   settles in its own short transaction with a status-guarded UPDATE.
// - Poison rows back off exponentially (M6 fix).
//
// Run: npx tsx scripts/reconcile.ts  (cron: every 15 min in production)
import { forUpdate, query, withTx, withAdvisoryLock } from '../db.js';
import { getCheckPos, TENDER_BLIND_POS } from './pos/context.js';
import { effectivePlan, ensureBillingAccount, feeFor, recordFee } from './billing.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PosTender } from './pos/types.js';

const STUCK_AFTER_MIN = 10;
const GIVE_UP_AFTER_H = 24;
// Adapters whose getCheckDetail cannot report tenders: amount matching is
// meaningless there, so we never mark FAILED for them. Helcim qualifies
// (F-1): its check detail carries no tender list, so a Helcim row can only
// ever resolve by exact reference — never by amount, never auto-FAILED.
const NO_TENDER_ADAPTERS = TENDER_BLIND_POS; // single source: pos/context.ts (F1-19)

interface PendingRow {
  id: string;
  check_id: string;
  amount_cents: number;
  tip_cents: number;
  idempotency_key: string;
  pos_tender_ref: string | null;
  reconcile_attempts: number;
  created_at: string;
  last_reconcile_at: string | null;
}

export async function reconcilePendingPayments(): Promise<{ reconciled: number; failed: number; stillPending: number }> {
  // F-6: the run used to execute inside ONE transaction — up to 100 rows,
  // a live POS call per row, the job advisory lock and every row lock held
  // for the whole batch. Now: a session-level try-lock guards the run,
  // due rows are selected lock-free, and each row resolves in its OWN
  // short transaction (the POS call happens before the write transaction
  // even opens). If another reconciler is already running, skip quietly.
  const r = await withAdvisoryLock('smart-table-reconcile', () => reconcileRun(), { runIfUnsupported: true });
  if (r === null) {
    console.log('[reconcile] another run is in progress — skipping');
    return { reconciled: 0, failed: 0, stillPending: 0 };
  }
  return r;
}

async function reconcileRun(): Promise<{ reconciled: number; failed: number; stillPending: number }> {
  let reconciled = 0, failed = 0, stillPending = 0;

  // M6 fix: poison rows back off — a row that errored N times waits 2^N minutes.
  // F2-2: the backoff used to be computed in SQL as
  // make_interval(mins => LEAST(2 ^ reconcile_attempts, 240)) — on real
  // Postgres `2 ^ n` is double precision and make_interval(mins => double)
  // does not exist, so EVERY run failed there (pg-mem tolerated it, which
  // is why the suite never noticed; and pg-mem's parser rejects the
  // integer-cast form real Postgres needs). The due check now happens in
  // JS: portable to both, and the exponent is capped before it can
  // overflow anything.
  // (Both cutoffs are computed in JS and passed as plain timestamps:
  // make_interval with a bound parameter parses on neither pg-mem nor —
  // with the old expression — real Postgres.)
  const stuckBefore = new Date(Date.now() - STUCK_AFTER_MIN * 60000).toISOString();
  const { rows: candidates } = await query<PendingRow>(
    `SELECT id, check_id, amount_cents, tip_cents, idempotency_key, pos_tender_ref,
            reconcile_attempts, created_at, last_reconcile_at
     FROM payments
     WHERE status = 'PENDING'
       AND created_at < $1
     ORDER BY created_at ASC LIMIT 500`,
    [stuckBefore],
  );
  const nowMs = Date.now();
  const rows = candidates
    .filter((p) => {
      if (!p.last_reconcile_at) return true;
      const backoffMin = Math.min(2 ** Math.min(p.reconcile_attempts, 8), 240);
      return new Date(p.last_reconcile_at).getTime() < nowMs - backoffMin * 60000;
    })
    .slice(0, 100);

  for (const p of rows) {
    const outcome = await reconcileRow(p);
    if (outcome === 'reconciled') reconciled++;
    else if (outcome === 'failed') failed++;
    else stillPending++;
  }
  return { reconciled, failed, stillPending };
}

async function reconcileRow(p: PendingRow): Promise<'reconciled' | 'failed' | 'pending'> {
  try {
    const ageH = (Date.now() - new Date(p.created_at).getTime()) / 3_600_000;
    const ctx = await getCheckPos(p.check_id);
    const detail = await ctx.adapter.getCheckDetail(ctx.checkRef, ctx.token);
    const canSeeTenders = !NO_TENDER_ADAPTERS.has(ctx.posType);

    // Tender IDs we already recorded for this check — never match these again.
    const recordedRefs = await query<{ ref: string }>(
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
    //    have a real (non-zero) amount to match on. F-1: a tender
    //    reports the TOTAL tendered (amount + tip), so match on the sum
    //    — matching the bare amount misses every tipped payment — and
    //    require the match to be UNIQUE: two fresh tenders with the
    //    same total are ambiguous evidence, not a match.
    if (!matched && canSeeTenders && p.amount_cents > 0) {
      const wanted = p.amount_cents + p.tip_cents;
      const candidates = freshTenders.filter((t: PosTender) => t.amountCents === wanted);
      if (candidates.length === 1) matched = candidates[0];
    }

    if (matched) {
      const closed = detail.remainingCents <= 0;
      // Per-row write transaction: re-check PENDING under the row lock,
      // then settle the payment (+ check/table when closed).
      const settled = await withTx(async (client) => {
        // F2-15: lock the check row first, in the same order payCheck
        // takes it, so a delayed reconcile can't interleave with a live
        // payment on the same check.
        await client.query(`SELECT id FROM checks WHERE id = $1${forUpdate()}`, [p.check_id]);
        // H6 fix: guard the UPDATE with AND status='PENDING'.
        const upd = await client.query(
          `UPDATE payments SET status = $2, external_payment_ref = COALESCE(external_payment_ref, $3),
             remaining_after_cents = $4, check_state = $5, currency = $6,
             reconcile_attempts = 0, last_reconcile_at = now()
           WHERE id = $1 AND status = 'PENDING'`,
          [p.id, closed ? 'COMPLETED' : 'AUTHORIZED', matched!.id,
           Math.max(0, detail.remainingCents), closed ? 'COMPLETED' : 'OPEN', detail.currency],
        );
        if ((upd.rowCount ?? 0) === 0) return false; // someone else resolved it
        if (closed) {
          // F2-15: promote sibling AUTHORIZED rows, exactly like
          // payCheck's completion tail — a check reconcile closes must
          // not leave its other payments half-settled.
          await client.query(
            `UPDATE payments SET status='COMPLETED' WHERE check_id=$1 AND status='AUTHORIZED'`,
            [p.check_id],
          );
          await client.query(`UPDATE checks SET state='COMPLETED' WHERE id=$1`, [p.check_id]);
          const chk = await client.query<{ table_id: string | null }>(
            `SELECT table_id FROM checks WHERE id=$1`, [p.check_id]);
          const tableId = chk.rows[0]?.table_id;
          if (tableId) {
            // F2-9: this reconcile may run hours late — only flip the
            // table when it's still working THIS check's party: still in
            // SEATED/PAYING and with no OTHER open check (a re-seated
            // table's new party has one). This check itself was marked
            // COMPLETED just above, so it doesn't count. A table that
            // fails the guard is untouched, and no phantom 'paid' event
            // is written for it.
            const tu = await client.query(
              `UPDATE tables SET state='PAID' WHERE id=$1 AND state IN ('SEATED','PAYING')
               AND NOT EXISTS (SELECT 1 FROM checks WHERE table_id = $1 AND state = 'OPEN')`,
              [tableId],
            );
            if ((tu.rowCount ?? 0) > 0) {
              await client.query(`INSERT INTO events(id, table_id, check_id, type) VALUES($1,$2,$3,'paid')`,
                [randomUUID(), tableId, p.check_id]);
            }
          }
        }
        return true;
      });
      if (!settled) return 'pending';
      // F-7: record the commission fee for the settled payment, with
      // the same rules as the live path. The live path writes its fee
      // row on an autocommit connection precisely so it survives the
      // rollback that stranded this payment — so the row usually
      // exists already and the (payment_row_id, method) unique index
      // (migration 017) makes this a no-op. It only lands when the
      // live write itself failed. If ANY fee row exists for this
      // payment, skip: guessing a second method could double-collect.
      try {
        const priorFee = await query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM fee_ledger WHERE payment_row_id = $1 AND method IN ('square_app_fee','accrued')`,
          [p.id],
        );
        if ((priorFee.rows[0]?.n ?? 0) === 0 && ctx.locationId) {
          const acct = await ensureBillingAccount(ctx.locationId);
          if (effectivePlan(acct) === 'commission') {
            const fee = feeFor(p.amount_cents + p.tip_cents, acct.commission_bps);
            if (fee > 0) {
              await recordFee({
                locationId: ctx.locationId,
                paymentRowId: p.id,
                posPaymentRef: matched.id,
                chargeCents: p.amount_cents + p.tip_cents,
                feeCents: fee,
                currency: detail.currency,
                // Square's first attempt carries the fee in-flight;
                // presuming collected can only ever LOSE a fee, never
                // double-charge the restaurant. Other POS accrue.
                method: ctx.posType === 'square' ? 'square_app_fee' : 'accrued',
              });
            }
          }
        }
      } catch (feeErr) {
        // Never silent: a settled payment with no fee row is lost revenue.
        console.error(`[reconcile] fee recording failed for payment ${p.id}:`, feeErr);
      }
      console.log(`[reconcile] ${p.idempotency_key}: POS tender ${matched.id} -> ${closed ? 'COMPLETED' : 'AUTHORIZED'}`);
      return 'reconciled';
    }

    if (ageH > GIVE_UP_AFTER_H && canSeeTenders && !p.pos_tender_ref && freshTenders.length > 0) {
      // F2-3: unrecorded tenders EXIST on this check but none matched this
      // row uniquely — ambiguous evidence (equal-split twins produce
      // identical amounts; a lost amount write leaves amount_cents = 0).
      // The old code marked such rows FAILED after 24h even though the
      // money was taken. Ambiguity is a human's call: flag and keep
      // backing off, exactly like the stored-ref case below.
      await query(
        `UPDATE payments SET reconcile_attempts = reconcile_attempts + 1, last_reconcile_at = now(),
           last_reconcile_error = 'MANUAL REVIEW: unmatched POS tenders present after 24h (ambiguous or amount unknown)'
         WHERE id = $1`,
        [p.id],
      );
      console.error(`[reconcile] MANUAL REVIEW ${p.idempotency_key}: ${freshTenders.length} unmatched tender(s) after ${ageH.toFixed(1)}h — left PENDING`);
      return 'pending';
    }

    if (ageH > GIVE_UP_AFTER_H && canSeeTenders && !p.pos_tender_ref) {
      // H5 fix: FAILED only after a POSITIVE check — the adapter reports
      // tenders and there are NO unrecorded tenders at all on the check
      // (the branch above handles "some exist but none matched"). Never
      // FAILED when we can't see tenders.
      // F-1 fix: also never FAILED when we hold a stored tender
      // reference — the charge DID succeed at the POS (the ref was
      // written the moment it landed); an unmatched ref after 24h is
      // contradictory evidence for a human, not proof of no payment.
      await query(
        `UPDATE payments SET status='FAILED', reconcile_attempts = 0, last_reconcile_at = now()
         WHERE id=$1 AND status='PENDING'`,
        [p.id],
      );
      console.log(`[reconcile] ${p.idempotency_key}: no POS tender after ${ageH.toFixed(1)}h -> FAILED`);
      return 'failed';
    }

    if (ageH > GIVE_UP_AFTER_H && p.pos_tender_ref && !matched) {
      // F-1: stored tender ref, still unmatched after 24h — flag for
      // manual review and keep backing off; never auto-resolve either way.
      await query(
        `UPDATE payments SET reconcile_attempts = reconcile_attempts + 1, last_reconcile_at = now(),
           last_reconcile_error = 'MANUAL REVIEW: stored POS tender ref not present in check detail after 24h'
         WHERE id = $1`,
        [p.id],
      );
      console.error(`[reconcile] MANUAL REVIEW ${p.idempotency_key}: stored tender ref ${p.pos_tender_ref} not in POS detail after ${ageH.toFixed(1)}h — left PENDING`);
      return 'pending';
    }

    await query(
      `UPDATE payments SET reconcile_attempts = reconcile_attempts + 1, last_reconcile_at = now()
       WHERE id = $1`,
      [p.id],
    );
    return 'pending';
  } catch (e) {
    // M6 fix: record the error and back off; the row ages out of the batch.
    await query(
      `UPDATE payments SET reconcile_attempts = reconcile_attempts + 1,
         last_reconcile_error = $2, last_reconcile_at = now() WHERE id = $1`,
      [p.id, e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500)],
    ).catch(() => undefined);
    console.error(`[reconcile] ${p.idempotency_key}: error`, e instanceof Error ? e.message : e);
    return 'pending';
  }
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
