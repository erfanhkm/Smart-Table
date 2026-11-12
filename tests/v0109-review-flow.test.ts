// v0.10.9: C3-9 M8 — Erfan's review-flow decision (2026-11-11), after
// sourced research confirmed review gating violates Google's policy ban
// on selectively soliciting positive reviews.
//
// THE INVARIANT under test: after payment, EVERY guest can reach the
// Google review link and the private feedback option with equal
// prominence — regardless of the star rating they give, and regardless
// of whether they rate at all. The rating never gates, hides, delays,
// reorders or de-emphasizes the Google option. The rating itself stays:
// it is private feedback + internal metrics, and a 1-3 star rating must
// still raise the Service Recovery alert exactly as before.
//
// Proves:
//  1. The bill payload (GET /api/t/:token) carries the location's
//     google_review_url, so the guest page can offer the Google option
//     before/without any rating (null when the location never set one).
//  2. POST /feedback returns the SAME google_review_url for a 1-star, a
//     3-star and a 5-star rating (before v0.10.9 the server itself
//     withheld it below 4 stars: `rating >= 4 ? url : null`).
//  3. The low-rating Service Recovery alert still fires (exactly one,
//     deduped); a high rating raises none.
//  4. Client pins: the guest app renders the Google block from a single
//     helper on BOTH renderRating paths (pre-rating and post-rating),
//     the old `rated >= 4` link gate is gone from the served source, and
//     the googleReviewHelp copy no longer presupposes a happy guest in
//     any of the 5 locales.
//  5. Site pins: the demo models both options in every state, and the
//     gating copy ("before they become a public review") is gone from
//     demo.html / owner-demo.html / index.html / demo.js.
//
// Run: PG_MEM=1 npx tsx --test tests/v0109-review-flow.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = ['v0109', 'staff', 'token'].join('-');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');

const MERCHANT = 'm-rf';
const LOC = 'loc-rf';
const LOC_NO_URL = 'loc-rf-nourl';
const REVIEW_URL = 'https://g.page/r/review-flow-probe/review';

async function seed() {
  await migrate();
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'square','sq-merchant-rf',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency, google_review_url)
    VALUES ($1,$2,'square','SQLocRF1','SQLocRF1','Review House','CAD',$3)`, [LOC, MERCHANT, REVIEW_URL]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,$2,'square','SQLocRF2','SQLocRF2','No Link House','CAD')`, [LOC_NO_URL, MERCHANT]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1','tok-rf','SEATED')`, [randomUUID(), LOC]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T2','tok-rf-nourl','SEATED')`, [randomUUID(), LOC_NO_URL]);
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const guestJs = read('../public/t/app.js');
const demoJs = read('../site/demo.js');
const demoHtml = read('../site/demo.html');
const ownerDemoHtml = read('../site/owner-demo.html');
const indexHtml = read('../site/index.html');

describe('v0.10.9 M8: the Google review link is never gated by the rating', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const staff = { authorization: `Bearer ${process.env.STAFF_API_TOKEN}` };
  before(async () => {
    await seed();
    app = await buildApp();
  });

  it('the bill payload carries google_review_url before any rating exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/t/tok-rf' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).google_review_url, REVIEW_URL,
      'a guest who never rates must still be able to reach the Google option');

    const bare = await app.inject({ method: 'GET', url: '/api/t/tok-rf-nourl' });
    assert.equal(bare.statusCode, 200);
    assert.equal(JSON.parse(bare.body).google_review_url, null,
      'a location without a configured link passes null through, unchanged');
  });

  it('feedback returns the identical google_review_url for 1, 3 and 5 stars', async () => {
    for (const rating of [5, 3, 1]) {
      const res = await app.inject({ method: 'POST', url: '/api/t/tok-rf/feedback', payload: { rating } });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).google_review_url, REVIEW_URL,
        `rating ${rating} must receive the same Google link as any other rating`);
    }
  });

  it('the low-rating Service Recovery alert still fires, deduped; high ratings raise none', async () => {
    const alerts = async () => {
      const res = await app.inject({ method: 'GET', url: `/api/service-alerts?location_id=${LOC}`, headers: staff });
      assert.equal(res.statusCode, 200);
      return JSON.parse(res.body).alerts;
    };
    // The 5-star post above raised nothing; the 3-star and 1-star posts
    // collapse into exactly one open low_rating alert (dedupe unchanged).
    const open = await alerts();
    assert.equal(open.length, 1, 'exactly one open alert after 3-star + 1-star feedback');
    assert.equal(open[0].kind, 'low_rating');
  });
});

describe('v0.10.9 M8: guest app + demo render both options in every state', () => {
  it('the old rating gate is gone from the served guest source', () => {
    assert.ok(!guestJs.includes('rated >= 4 && safeReviewUrl'), 'post-rating Google card is no longer 4-5★ only');
    assert.ok(!guestJs.includes('rating >= 4 ?'), 'no rating-conditional review URL anywhere in the guest app');
    const server = read('../src/routes/customer.ts');
    assert.ok(!server.includes('rating >= 4 ? t.rows[0].google_review_url : null'), 'server no longer withholds the URL below 4 stars');
    assert.ok(server.includes('google_review_url: t.rows[0].google_review_url ?? null'), 'feedback returns the URL for every rating');
    assert.ok(server.includes('google_review_url: table.google_review_url ?? null'), 'bill payload carries the URL');
  });

  it('one shared Google block renders on BOTH renderRating paths', () => {
    assert.ok(guestJs.includes('function googleReviewBlock()'), 'shared helper exists');
    const slice = guestJs.slice(guestJs.indexOf('function googleReviewBlock()'), guestJs.indexOf('function renderLoyalty()'));
    const calls = (slice.match(/googleReviewBlock\(\)/g) || []).length;
    assert.ok(calls >= 3, `helper defined once and called on both paths (found ${calls})`);
    assert.ok(slice.includes('if (ratingDone)'), 'post-rating path present');
    assert.ok(slice.indexOf('${googleReviewBlock()}') > slice.indexOf('if (ratingDone)'), 'post-rating path closes with the Google block');
    assert.ok(slice.lastIndexOf('${googleReviewBlock()}') > slice.indexOf('howWasIt'), 'pre-rating path also closes with the Google block');
    assert.ok(guestJs.includes("reviewUrl = data.google_review_url || null"), 'client takes the URL from the bill payload, not only from a rating submit');
  });

  it('googleReviewHelp is neutral in all 5 guest locales (shown to every guest now)', () => {
    for (const oldText of [
      'Glad you loved it — a quick Google review helps us a lot.',
      'خوشحالیم که راضی بودید — یک نظر کوتاه در گوگل خیلی به ما کمک می‌کند.',
      '很高兴您喜欢——在 Google 上留下简短评价对我们帮助很大。',
      'खुशी है कि आपको पसंद आया — Google पर एक छोटी समीक्षा हमारी बहुत मदद करती है।',
      'ਖੁਸ਼ੀ ਹੈ ਕਿ ਤੁਹਾਨੂੰ ਪਸੰਦ ਆਇਆ — Google \'ਤੇ ਛੋਟੀ ਸਮੀਖਿਆ ਸਾਡੀ ਬਹੁਤ ਮਦਦ ਕਰਦੀ ਹੈ।',
    ]) {
      assert.ok(!guestJs.includes(oldText), `presupposing copy removed from the guest app: ${oldText.slice(0, 24)}…`);
      assert.ok(!demoJs.includes(oldText), `presupposing copy removed from the demo: ${oldText.slice(0, 24)}…`);
    }
  });

  it('the demo models both options in every state', () => {
    assert.ok(demoJs.includes('function googleBlockHtml()'), 'demo has the shared Google block');
    assert.ok(!demoJs.includes('if (!zone || state.rated === 0) return;'), 'rate zone no longer renders only after a rating');
    assert.ok(demoJs.includes('html + googleBlockHtml()'), 'Google block closes the rate zone in every state');
    assert.ok(demoJs.includes('renderRateZone(); // v0.10.9 (M8)'), 'success screen renders the zone before any rating');
    assert.ok(!demoJs.includes('(private, not a public review)'), 'gating framing removed from the recovery feed line');
    assert.ok(demoHtml.includes('/demo.js?v=6'), 'demo.js cache pin bumped');
  });

  it('gating copy is gone from the marketing pages', () => {
    assert.ok(!demoHtml.includes('before</em> they become a public review'), 'demo.html owner list no longer sells interception');
    assert.ok(demoHtml.includes('Every guest is offered both a public Google review and private feedback'), 'demo.html states the equal offer');
    assert.ok(ownerDemoHtml.includes('private feedback is an extra channel, never a filter'), 'owner-demo Live floor caption states the equal offer');
    assert.ok(indexHtml.includes('every guest is offered a public Google review and private feedback'), 'index.html plan bullet states the equal offer');
  });

  it('release version is 0.10.9', () => {
    const pkg = JSON.parse(read('../package.json')) as { version: string };
    assert.equal(pkg.version, '0.10.9', 'package.json at 0.10.9');
  });
});
