// v0.6.11 smalls tests — Claude cycle-1 backlog batch 2 (I-3..I-6).
//
// These are source-shape tests over public/portal/app.js, in the same
// style as the H-5/H-6/H-3 assertions in v0610-backlog.test.ts:
//
//  1. I-3: a refund attempt's idempotency key survives a 5xx (unknown
//     outcome), exactly like a 409 — it is dropped only on a confirmed
//     success or a confirmed (4xx) rejection, so a retry can never mint
//     a fresh key and refund twice.
//  2. I-4: the cash flow mints its idempotency key through a guarded
//     helper (newCashKey) instead of calling crypto.randomUUID()
//     unguarded, which throws where randomUUID is unavailable.
//  3. I-5: both OAuth navigation sites verify the server-returned URL
//     with isSquareAuthorizeUrl (Square hosts + /oauth2/authorize only)
//     before assigning window.location.
//  4. I-6: server-supplied numeric fields are interpolated into portal
//     HTML through num() (Number() coercion), never raw.
//
// Run: PG_MEM=1 npx tsx --test tests/v0611-smalls.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../public/portal/app.js', import.meta.url), 'utf8');

describe('v0.6.11 portal smalls (I-3..I-6)', () => {
  it('I-3: refund key is kept on 5xx unknown outcomes', () => {
    assert.ok(src.includes('out.status >= 500'), 'refund flow must branch on 5xx');
    const i5xx = src.indexOf('out.status >= 500');
    const blockEnd = src.indexOf('} else {', i5xx);
    const block = src.slice(i5xx, blockEnd);
    assert.ok(!block.includes('delete attempts[sig]'), 'the 5xx branch must NOT drop the refund key');
    // The definitive-rejection branch (plain else) still drops it.
    assert.ok(src.includes("alert(out.error || 'Refund failed.');"), 'definitive rejection path still present');
  });

  it('I-4: cash flow uses the guarded key helper, never a bare randomUUID', () => {
    assert.ok(src.includes('function newCashKey()'), 'guarded cash key helper must exist');
    assert.ok(src.includes('key: newCashKey()'), 'cash attempt must mint its key via the helper');
    assert.ok(!src.includes('key: crypto.randomUUID()'), 'unguarded randomUUID in the cash flow must be gone');
  });

  it('I-5: OAuth navigations verify the authorize URL origin first', () => {
    assert.ok(src.includes('function isSquareAuthorizeUrl(u)'), 'authorize-URL guard must exist');
    assert.ok(src.includes("url.hostname === 'connect.squareup.com'"), 'production Square host allow-listed');
    assert.ok(src.includes("url.hostname === 'connect.squareupsandbox.com'"), 'sandbox Square host allow-listed');
    const navs = src.match(/window\.location\.href = url;/g) ?? [];
    assert.equal(navs.length, 2, 'both OAuth sites navigate via the checked url variable');
    const guards = src.match(/if \(!isSquareAuthorizeUrl\(url\)\)/g) ?? [];
    assert.equal(guards.length, 2, 'both OAuth sites check the URL before navigating');
    assert.ok(!src.includes('window.location.href = await PortalAPI.startOAuth()'), 'no unguarded direct navigation remains');
  });

  it('I-6: numeric fields are Number()-coerced before HTML interpolation', () => {
    assert.ok(src.includes('function num(v)'), 'num() coercion helper must exist');
    for (const wrapped of ['num(tbl.count)', 'num(met.open_calls)', 'num(x.checks)', 'num(x.share_pct)', 'num(d.battery)', 'num(st.commission_percent)']) {
      assert.ok(src.includes(wrapped), `expected ${wrapped} in portal app.js`);
    }
    assert.ok(!src.includes('${x.checks}'), 'raw x.checks interpolation must be gone');
    assert.ok(!src.includes('${d.battery}%'), 'raw d.battery interpolation must be gone');
    assert.ok(!src.includes('${st.commission_percent}%'), 'raw commission_percent interpolation must be gone');
  });
});
