// v0.10.8: Claude cycle-3 chunk C3-9 fixes (marketing site + demos + blog).
//
// Source-shape assertions over the reviewed site/ surfaces, in the
// v0811/v0107 style: there is no DOM harness for these pages, so these pin
// the load-bearing shapes (honest plan/device copy, demo correctness, i18n
// completeness). The M1 check is executable: it parses demo.js's I18N table
// and asserts every t('…') literal exists in every locale.
//
// Run: PG_MEM=1 npx tsx --test tests/v0108-c39-hardening.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const site = async (p: string) => readFile(new URL('../site/' + p, import.meta.url), 'utf8');
const index = await site('index.html');
const demoHtml = await site('demo.html');
const demoJs = await site('demo.js');
const ownerDemo = await site('owner-demo.html');
const privacy = await site('privacy.html');
const terms = await site('terms.html');
const blogArticle = await site('blog/qr-code-payment-restaurants-guide.html');
const sitemap = await site('sitemap.xml');
const securityTxt = await site('.well-known/security.txt');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

describe('v0.10.8 C3-9 marketing claims (H2/H3/H4/M6/M7/M10)', () => {
  it('H2: Base is not sold as "Available now" with a shipping device', () => {
    assert.ok(index.includes('Software available now · device planned'), 'Base badge carries the planned-device framing');
    assert.ok(!index.includes('>Available now<'), 'bare Available-now badge is gone');
    assert.ok(!index.includes('Includes the STT-101 table device'), 'plan-sub no longer claims the device is included');
    assert.ok(index.includes('founding restaurants get first units'), 'Base bullet uses planned framing');
  });

  it('H3: one device rule everywhere — sold separately, one-time, per table', () => {
    assert.ok(terms.includes('devices are sold separately as a one-time purchase per table'), 'Terms §3 Base states the single rule');
    assert.ok(!terms.includes('Base includes the STT-101 table device on each table'), 'Terms §3 contradiction removed');
    assert.ok(terms.includes('the Base price buys the software feature set'), 'Terms says plainly what Base buys before devices ship');
    assert.ok(ownerDemo.includes('separate one-time purchase per table'), 'owner-demo billing caption aligned');
  });

  it('H4: the demo presents the device as planned, not shipping', () => {
    assert.ok(demoHtml.includes('Planned device — simulated here'), 'device column carries the planned marker');
    assert.ok(!demoHtml.includes('This is the real flow, end to end: the device'), 'hero no longer presents the device as real');
    assert.ok(demoHtml.includes('The STT-101 is planned: it will show'), 'FAQ uses planned framing');
  });

  it('M6: waiter-call is not presented as a live feature', () => {
    assert.ok(!index.includes('waiter response time'), 'live metrics list drops waiter response time');
    assert.ok(index.includes('Waiter-call queue — planned with the device'), 'owners card is planned-framed');
    assert.ok(!ownerDemo.includes('live floor, waiter calls'), 'owner-demo meta drops present-tense waiter calls');
    assert.ok(ownerDemo.includes('arrive with the STT-101 table device'), 'owner-demo caption is planned-framed');
  });

  it('M7: Founding Pilot terms agree across homepage, Terms and blog', () => {
    assert.ok(index.includes('Founding Pilot'), 'homepage names the pilot');
    assert.ok(index.includes('free for 30 days'), 'homepage states the pilot terms');
    assert.ok(terms.includes('Founding Pilot'), 'Terms §3 carries the pilot');
    assert.ok(terms.includes('no charge is made'), 'Terms states the no-chosen-plan end rule');
    assert.ok(blogArticle.includes('Tip prompts with clear preset percentages'), 'blog tip-checklist narrowed to what ships');
    assert.ok(!blogArticle.includes('Tip prompts you control'), 'overclaim removed');
  });

  it('M10: QR ordering is a Starter feature enabled per location, not Base-only', () => {
    assert.ok(index.includes('QR ordering from your POS menu (enable it per location in your portal)'), 'Starter card lists ordering');
    assert.equal(index.split('QR ordering from your POS menu').length - 1, 1, 'ordering bullet appears exactly once (Starter)');
  });
});

describe('v0.10.8 C3-9 demo correctness (M1/M2/M9, L-a/L-b/L-c)', () => {
  it('M1: every t() key in demo.js exists in every locale', () => {
    const m = demoJs.match(/const I18N = (\{[\s\S]*?\});/);
    assert.ok(m, 'I18N table found in demo.js');
    const i18n = JSON.parse(m[1]) as Record<string, Record<string, string>>;
    const keys = new Set([...demoJs.matchAll(/\bt\('([A-Za-z]+)'/g)].map((x) => x[1]));
    assert.ok(keys.size >= 40, 'a real key set was extracted');
    for (const k of keys) {
      for (const loc of ['en', 'fa', 'zh', 'hi', 'pa']) {
        assert.ok(i18n[loc] && k in i18n[loc], `key ${k} missing from locale ${loc}`);
      }
    }
    assert.ok(!demoJs.includes('भुगताना'), 'HI processing typo fixed');
  });

  it('M2: the pay timer is stored, cleared on replay, and phase-guarded', () => {
    assert.ok(demoJs.includes('state.payTimer = setTimeout('), 'timer id kept');
    assert.ok(demoJs.includes('clearTimeout(state.payTimer)'), 'replay clears the timer');
    assert.ok(demoJs.includes("if (state.phase !== 'processing') return;"), 'callback re-checks the phase');
  });

  it('M9: the demo test card is Square sandbox 4111…, never Stripe 4242…', () => {
    assert.ok(demoHtml.includes('4111 1111 1111 1111'), 'demo.html shows the Square sandbox card');
    assert.ok(demoJs.includes('4111 1111 1111 1111'), 'demo.js pre-fills the Square sandbox card');
    assert.ok(!demoHtml.includes('4242'), 'no Stripe test number on demo.html');
    assert.ok(!demoJs.includes('4242'), 'no Stripe test number in demo.js');
  });

  it('L-c: equal split rounds up like the real app; partial receipts show the share line', () => {
    assert.ok(demoJs.includes('Math.ceil(TOTAL_CENTS / state.people)'), 'equal split uses Math.ceil');
    assert.ok(demoJs.includes('Your share of the check'), 'partial-payment receipt shows the share line');
    assert.ok(demoJs.includes('id="custAmt" type="text"'), 'custom amount is a text input like the real app');
  });

  it('L-a/L-b: success state survives re-renders; recovery alert appends', () => {
    assert.ok(demoJs.includes('state.receiptMsg'), 'receipt outcome is kept in state');
    assert.ok(demoJs.includes('renderRateZone()'), 'rating zone renders from state');
    assert.ok(demoJs.includes('appendChild(row)'), 'service-recovery alert appends instead of overwriting');
    assert.ok(!demoJs.includes("$('alertZone').innerHTML = '<div class=\"alert-row red\">"), 'alert overwrite is gone');
  });
});

describe('v0.10.8 C3-9 site hygiene (H1/M3/M4/M5/L-e/L-i/L-l/L-m/L-n/L-o)', () => {
  it('H1: Persian card headings escape letter-spacing/uppercase in the demo', () => {
    assert.ok(demoHtml.includes('#phoneApp[lang="fa"] .g-card h4'), 'FA-scoped h4 rule present');
  });

  it('M3: the demo time-saved figure is labelled illustrative and matches the ROI model', () => {
    assert.ok(!demoHtml.includes('~12 min'), 'hardcoded ~12 min is gone');
    assert.ok(demoHtml.includes('Estimated time saved per table (illustrative)'), 'illustrative label present');
  });

  it('M4/M5/L-l: ROI has an adoption slider, named inputs, and the real BC wage floor', () => {
    assert.ok(index.includes('id="roi-adopt"'), 'adoption slider exists');
    assert.ok(index.includes('extraSeatings * check - 99'), 'revenue is net of the Base plan fee');
    assert.ok(index.includes('for="roi-wage"'), 'ROI labels are for-linked');
    assert.ok(index.includes('id="roi-wage" min="18.25"'), 'wage slider starts at the BC minimum wage');
    assert.ok(!index.includes('value="17.5"'), 'stale $17.50 default is gone');
  });

  it('L-e: demo.js cache pin bumped with the fixes', () => {
    assert.ok(demoHtml.includes('/demo.js?v=5'), 'demo.html pins demo.js?v=5');
  });

  it('L-i: owner-demo has a main landmark; privacy lists the website field', () => {
    assert.ok(ownerDemo.includes('<main id="main">'), 'owner-demo wraps content in <main>');
    assert.ok(privacy.includes('your restaurant website if you provide one'), 'privacy §1 lists the website field');
  });

  it('L-m/L-n/L-o: dates, address and security.txt are consistent', () => {
    assert.ok(terms.includes('Last updated: November 11, 2026'), 'terms date matches this revision');
    assert.ok(!sitemap.includes('2026-11-01') && !sitemap.includes('2026-10-29'), 'sitemap lastmods refreshed');
    assert.ok(!index.includes('"addressLocality": "Vancouver"'), 'schema address aligned to the published Coquitlam address');
    assert.ok(!securityTxt.includes('Policy:'), 'security.txt no longer points Policy at the privacy policy');
  });

  it('release version is 0.10.8', () => {
    assert.equal(pkg.version, '0.10.8', 'package.json at 0.10.8');
  });
});
