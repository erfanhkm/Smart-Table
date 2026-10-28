// v0.8.11 F8 hardening tests — Claude cycle-2 chunk F8 (guest app.js).
//
// Source-shape assertions over public/t/app.js (+ its index.html), in the
// same style as v088-f7-hardening.test.ts. There is no DOM harness for the
// guest page; these pin the load-bearing shapes of each F8 fix so a future
// edit cannot silently revert them.
//
// Run: PG_MEM=1 npx tsx --test tests/v0811-f8-hardening.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../public/t/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/t/index.html', import.meta.url), 'utf8');
const fn = (name: string) => {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  return src.slice(i, src.indexOf('\n}', i) + 2);
};

describe('v0.8.11 F8 guest hardening', () => {
  it('F8-2: attempt TTL is 24h and reconcileAttempt never clears the attempt', () => {
    assert.ok(src.includes('const ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000'), 'TTL matches the provider key lifetime');
    const rec = fn('reconcileAttempt');
    assert.ok(!rec.includes('clearAttempt'), 'reconcile must keep the attempt (clearing could mint a fresh key after a landed charge)');
    assert.ok(rec.includes("t('billChanged')"), 'the guest is still pointed at Already paid');
    assert.ok(src.includes('function sweepAttempts()'), 'expired attempts are swept on load');
  });

  it('F8-3: processPayment snapshots the check and fetchBill is gated while paying', () => {
    assert.ok(src.includes('const snapCheck = check'), 'snapshot taken before the tokenize await');
    assert.ok(src.includes('snapCheck.items.filter'), 'success branch reads the snapshot, not the global');
    assert.ok(fn('fetchBill').includes('if (paying) return'), 'bill fetch cannot swap state mid-payment');
  });

  it('F8-4: wallet sheet cannot diverge from the charged total', () => {
    assert.ok(src.includes('walletState.key !== nowKey'), 'setup re-checks after a busy setup');
    assert.equal(src.split('walletState.key !== nowKey').length - 1, 3, 're-check in finally + both wallet tap guards');
    assert.ok(src.includes("t('tapAgain')"), 'a stale sheet asks for a fresh tap instead of charging');
  });

  it('F8-5: native-script digits are normalized at every numeric input', () => {
    assert.ok(src.includes('function normalizeDigits('), 'normalizer exists');
    assert.ok(src.includes('normalizeDigits(loyaltyPhone)'), 'loyalty phone');
    assert.ok(src.includes('normalizeDigits($(\'cc-num\')'), 'Clover fields');
    assert.ok(src.includes('parseFloat(normalizeDigits(e.target.value)'), 'custom amount');
    assert.ok(src.includes('<input type="text" inputmode="decimal"'), 'custom amount no longer uses type=number');
    assert.ok(!src.includes('<input type="number" inputmode="decimal"'), 'old swallowing input is gone');
  });

  it('F8-6: the order key survives unknown outcomes and is cart-bound', () => {
    assert.ok(src.includes('[400, 401, 403, 404, 422].includes(res.status)'), 'key dropped only on definitive 4xx');
    assert.ok(src.includes('function loadOrderKey()') && src.includes('function dropOrderKey()'), 'guarded storage helpers');
    assert.ok(src.includes('localStorage.getItem(\'st_order_key_\' + tableToken)'), 'localStorage, not sessionStorage');
    assert.ok(!src.includes('sessionStorage.getItem(cartKey)'), 'old sessionStorage shape is gone');
    assert.ok(src.includes('rec.sig === sig'), 'a changed cart mints a new key');
  });

  it('F8-7: provider hosts are allow-listed before card data moves', () => {
    assert.ok(src.includes('/(^|\\.)clover\\.com$/'), 'Clover token host suffix check');
    assert.ok(src.includes('/(^|\\.)helcim\\.(app|com)$/'), 'Helcim script host suffix check');
  });

  it('F8-8: Clover can be cancelled and Helcim never leaks or reuses a session', () => {
    assert.ok(src.includes("id=\"cc-cancel\""), 'Clover cancel button exists');
    assert.ok(src.includes('removeHelcimPayIframe'), 'Helcim iframe removed on outcomes');
    assert.ok(src.includes('finally { delete cardConfigCache[checkRef]; }'), 'Helcim checkout config dropped after each attempt');
  });

  it('F8-9: every guest fetch has a timeout; /pay gets 45s', () => {
    assert.ok(src.includes('async function fetchTimeout('), 'timeout helper exists');
    assert.ok(src.includes('}, 45000);'), 'pay call passes the 45s budget');
    assert.ok(!src.includes('await fetch(`/api/t/'), 'no raw bill fetch remains');
    assert.ok(!src.includes('await fetch(`/api/checks/'), 'no raw checks fetch remains');
  });

  it('F8-10: a failed feedback post is not shown as success', () => {
    const sr = fn('submitRating');
    assert.ok(sr.includes('if (ratingSubmitting || ratingDone) return'), 'in-flight guard');
    assert.ok(sr.includes('if (!res.ok) throw'), 'res.ok is checked');
    assert.ok(sr.indexOf('ratingDone = true') > sr.indexOf('if (!res.ok) throw'), 'done is set only after a confirmed ok');
    assert.ok(sr.includes("t('ratingFailed')"), 'failure shows a retry notice');
  });

  it('F8-11: RTL money is isolated and the paid-minus is a true minus in a bdi', () => {
    assert.ok(src.includes('⁦') && src.includes('⁩'), 'formatMoney wraps fa amounts in bidi isolates');
    assert.ok(src.includes('<bdi>−'), 'Already paid minus inside <bdi> with U+2212');
    assert.ok(!src.includes('text-align:left'), 'no physical left alignment remains');
    assert.ok(src.includes('text-align:start'), 'logical alignment used');
  });

  it('F8-12: bill fetches are sequenced and failed claims roll back', () => {
    assert.ok(src.includes('let billFetchSeq = 0'), 'sequence counter exists');
    assert.ok(src.includes('if (seq !== billFetchSeq) return'), 'stale responses are dropped');
    const tc = src.slice(src.indexOf('async function toggleClaim('));
    assert.ok(tc.includes('if (failed) { if (had) items[idx] = true'), 'optimistic claim reverts on failure');
  });

  it('F8-Lows: load race, loud env failure, dead placeholders, receipt guards', () => {
    assert.ok(src.includes('const scriptLoads = new Map()'), 'script loads share one promise');
    assert.ok(src.includes("if (!cfg.extra?.environment) throw"), 'missing Square environment fails loudly');
    assert.ok(!src.includes('SQUARE_APP_ID'), 'dead placeholder constants removed');
    assert.ok(src.includes('rel="noopener noreferrer"'), 'review link hardened');
    assert.ok(src.includes('let receiptEmailSending = false'), 'receipt email double-tap guard');
    assert.ok(src.includes("receiptPrintState === 'failed' || receiptPrintState === 'unavailable'"), 'failed print offers a retry');
    assert.ok(html.includes('/t/app.js?v=0.8.11'), 'guest script is version-pinned against the CDN cache');
  });

  it('i18n: all five languages keep identical keys and placeholders', () => {
    const start = src.indexOf('const I18N = ');
    const block = src.slice(start + 'const I18N = '.length, src.indexOf('};', start) + 1);
    const I18N = eval('(' + block + ')') as Record<string, Record<string, string>>;
    const base = Object.keys(I18N.en).sort();
    assert.equal(base.length, 114, '114 keys after the six F8 additions');
    for (const lang of Object.keys(I18N)) {
      assert.deepEqual(Object.keys(I18N[lang]).sort(), base, `${lang} key set matches en`);
      for (const k of base) {
        const a = (String(I18N.en[k]).match(/\{[a-z]+\}/g) || []).sort().join(',');
        const b = (String(I18N[lang][k]).match(/\{[a-z]+\}/g) || []).sort().join(',');
        assert.equal(b, a, `${lang}.${k} placeholders match en`);
      }
    }
  });
});
