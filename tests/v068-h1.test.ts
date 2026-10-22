// v0.6.8 — Claude cycle-1 section-2 consolidated list, item H-1 (High).
//
// The guest page's tenders block was:
//   check.tenders.map((t) => `... ${t('paymentWord')} ...`)
// The arrow parameter `t` shadowed the translation function `t`, so the
// first tender on an open check made render() throw a TypeError BEFORE the
// DOM was assigned — every phone at the table froze on a stale bill after
// a partial payment, and the payer never saw their confirmation.
//
// These tests pin the fix in public/t/app.js:
//  1. the shadowing pattern is gone and the tender parameter is `td`;
//  2. render() is a guarded wrapper around renderInner() (try/catch that
//     clears lastRenderKey so the next poll retries instead of freezing).
//
// Run: PG_MEM=1 npx tsx --test tests/v068-h1.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 't', 'app.js'), 'utf8');

describe('H-1: guest render() tenders shadowing', () => {
  it('tenders map no longer shadows the translation function t', () => {
    assert.ok(!src.includes('check.tenders.map((t)'), 'buggy shadowing pattern must not return');
    assert.ok(src.includes('check.tenders.map((td)'), 'tenders map must use the td parameter');
    assert.ok(src.includes("esc(td.type || t('cardWord'))"), 'tender type falls back to the translated card word');
    assert.ok(src.includes('formatMoney(td.amount_cents, check.currency)'), 'tender amount renders from td');
  });

  it('render() guards renderInner() with try/catch and clears the render key', () => {
    assert.ok(src.includes('function renderInner(force = false)'), 'render body moved to renderInner');
    const wrapper = src.slice(src.indexOf('function render(force = false)'), src.indexOf('function renderInner'));
    assert.ok(wrapper.includes('try { renderInner(force); } catch'), 'render() must wrap renderInner in try/catch');
    assert.ok(wrapper.includes('lastRenderKey = null'), 'a failed render must clear lastRenderKey so the next poll retries');
  });

  it('the fixed tenders expression evaluates without throwing (stub runtime)', () => {
    // Rebuild the exact expression shape from the fixed source with stubs:
    // t = translator, td = tender object. Before the fix this threw
    // "t is not a function" on the first tender.
    const t = (k: string) => ({ paymentWord: 'Payment', cardWord: 'Card' } as Record<string, string>)[k];
    const esc = (s: unknown) => String(s);
    const formatMoney = (c: number) => '$' + (c / 100).toFixed(2);
    const check = { currency: 'CAD', tenders: [{ type: 'CARD', amount_cents: 2500 }, { type: '', amount_cents: 1000 }] };
    const html = check.tenders.map((td) => `<span>${t('paymentWord')} (${esc(td.type || t('cardWord'))})</span><span>-${formatMoney(td.amount_cents, check.currency)}</span>`).join('');
    assert.ok(html.includes('Payment (CARD)'));
    assert.ok(html.includes('Payment (Card)'));
    assert.ok(html.includes('-$25.00'));
  });
});
