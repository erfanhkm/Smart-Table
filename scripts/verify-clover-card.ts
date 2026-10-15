// Verify Clover card payments end-to-end against the sandbox:
// 1. Tokenize a Clover test card (public Ecommerce token, token host)
// 2. Create a sandbox order with a line item
// 3. Charge it through cloverAdapter.chargeCard (private Ecommerce token)
// 4. Confirm the v3 order shows the payment and remaining == 0
//
// Requires: CLOVER_SANDBOX_API_TOKEN, CLOVER_SANDBOX_MERCHANT_ID,
//           CLOVER_ECOM_PUBLIC_TOKEN, CLOVER_ECOM_PRIVATE_TOKEN in env.
const REST = 'https://apisandbox.dev.clover.com';
const TOKEN_HOST = 'https://token-sandbox.dev.clover.com';

const merchantId = process.env.CLOVER_SANDBOX_MERCHANT_ID!;
const restToken = process.env.CLOVER_SANDBOX_API_TOKEN!;
const ecomPublic = process.env.CLOVER_ECOM_PUBLIC_TOKEN!;
const ecomPrivate = process.env.CLOVER_ECOM_PRIVATE_TOKEN!;
if (!merchantId || !restToken || !ecomPublic || !ecomPrivate) {
  console.error('missing Clover env (merchant id, REST token, ecom public/private)');
  process.exit(1);
}

const { cloverAdapter } = await import('../src/services/pos/clover.js');

async function rest(method: string, path: string, body?: unknown) {
  const r = await fetch(REST + path, {
    method,
    headers: { Authorization: `Bearer ${restToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`REST ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

// 1. Tokenize a Clover sandbox test card (4242424242424242) via the public token.
console.log('1. tokenizing test card...');
const tokRes = await fetch(`${TOKEN_HOST}/v1/tokens`, {
  method: 'POST',
  headers: { apikey: ecomPublic, 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    card: { number: '4242424242424242', exp_month: '12', exp_year: '2028', cvv: '123', brand: 'VISA' },
  }),
});
const tokJ = (await tokRes.json().catch(() => ({}))) as { id?: string; message?: string };
if (!tokRes.ok || !tokJ.id) throw new Error(`tokenize failed: ${tokRes.status} ${JSON.stringify(tokJ).slice(0, 300)}`);
console.log(`   token: ${tokJ.id.slice(0, 12)}...`);

// 2. Create a sandbox order with one line item.
console.log('2. creating sandbox order...');
const order = (await rest('POST', `/v3/merchants/${merchantId}/orders`, { state: 'open' })) as { id: string };
await rest('POST', `/v3/merchants/${merchantId}/orders/${order.id}/line_items`, {
  name: 'Card Verify Latte',
  price: 1500,
});
console.log(`   order ${order.id}`);

// 3. Charge through the adapter (Ecommerce charge + v3 payment record).
console.log('3. charging via cloverAdapter.chargeCard...');
const checkId = `${merchantId}:${order.id}`;
const res = await cloverAdapter.chargeCard!({
  checkId,
  amountCents: 1500,
  currency: 'USD',
  cardToken: tokJ.id,
  tipCents: 0,
  idempotencyKey: `verify-${Date.now()}`,
  priorPaymentIds: [],
  card: { publicToken: ecomPublic, privateToken: ecomPrivate },
  token: restToken,
});
console.log(`   paymentId=${res.paymentId} remaining=${res.remainingCents} ${res.currency}`);

// 4. Confirm via getCheckDetail.
const detail = await cloverAdapter.getCheckDetail(checkId, restToken);
console.log(`   detail: state=${detail.state} remaining=${detail.remainingCents} tenders=${detail.tenders.length}`);
if (detail.remainingCents !== 0) throw new Error('expected remaining 0 after full card payment');
if (res.remainingCents !== 0) throw new Error('chargeCard reported non-zero remaining');

console.log('\nCLOVER CARD VERIFY PASS');
