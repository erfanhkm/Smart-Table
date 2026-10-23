// Simulated STT-101 device — walks the full device lifecycle against an
// in-memory instance of the real backend (pg-mem), no hardware needed:
// pair -> idle state -> check opens -> button press -> receipt print -> ack
// -> heartbeat. This is the "virtual device" the firmware is developed
// against; the same calls are what the ESP32/Android client will make.
//
// Run: npx tsx scripts/sim-device.ts
process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
process.env.SQUARE_ACCESS_TOKEN = 'test-square-token';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

import { randomUUID } from 'node:crypto';

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { buildApp } = await import('../src/index.js');

const step = (n: number, msg: string, data?: unknown) =>
  console.log(`\n[${n}] ${msg}${data !== undefined ? `\n    ${JSON.stringify(data)}` : ''}`);

await migrate();
const app = await buildApp({ logger: false });
const STAFF = { authorization: 'Bearer test-token' };
const locId = randomUUID();
const tableId = randomUUID();

await query(
  `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
   VALUES ($1,'m-sim','square','SQLOCSIM','SQLOCSIM','Sim Bistro','CAD')`,
  [locId],
);
await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'Table 7','simqrtok','SEATED')`, [
  tableId,
  locId,
]);

step(1, 'Portal generates a pairing code for Table 7');
const codeRes = await app.inject({
  method: 'POST',
  url: '/api/portal/devices/claim-code',
  headers: STAFF,
  payload: { table_id: tableId },
});
const { code } = codeRes.json() as { code: string };
console.log(`    code = ${code} (expires in 10 minutes, single-use)`);

step(2, 'Device powers on and claims with the code');
const claimRes = await app.inject({ method: 'POST', url: '/api/device/claim', payload: { code } });
const claim = claimRes.json() as { device_token: string; table_token: string };
const DEV = { authorization: `Bearer ${claim.device_token}` };
console.log(`    got device token + table QR token "${claim.table_token}" (QR renders locally from here on)`);

step(3, 'Device polls state (idle table)');
let res = await app.inject({ method: 'GET', url: '/api/device/state', headers: DEV });
console.log(`    ${JSON.stringify(res.json())}  -> LED off, QR on screen`);

step(4, 'A check opens on the table (staff links it in the POS)');
await query(
  `INSERT INTO checks(id, table_id, location_id, external_check_ref, pos_type, state, total_cents, currency)
   VALUES ($1,$2,$3,'SIM-CHK-1','square','OPEN',4200,'CAD')`,
  [randomUUID(), tableId, locId],
);
res = await app.inject({ method: 'GET', url: '/api/device/state', headers: DEV });
console.log(`    ${JSON.stringify(res.json())}  -> LED blue breathing`);

step(5, 'Guest presses the physical service button');
res = await app.inject({ method: 'POST', url: '/api/device/call', headers: DEV, payload: {} });
console.log(`    call posted: ${JSON.stringify(res.json())}`);
res = await app.inject({ method: 'GET', url: '/api/device/state', headers: DEV });
console.log(`    ${JSON.stringify(res.json())}  -> LED amber solid`);

step(6, 'Staff send a receipt to the device printer');
const job = await app.inject({
  method: 'POST',
  url: `/api/tables/${tableId}/print-job`,
  headers: STAFF,
  payload: { lines: ['Sim Bistro', 'Table 7', 'TOTAL  $42.00 CAD', 'Thank you!'] },
});
const { job_id } = job.json() as { job_id: string };
res = await app.inject({ method: 'GET', url: '/api/device/print-jobs', headers: DEV });
console.log(`    device fetched: ${JSON.stringify(res.json())}`);
res = await app.inject({
  method: 'POST',
  url: `/api/device/print-jobs/${job_id}/ack`,
  headers: DEV,
  payload: { status: 'done' },
});
console.log(`    device acked the print: ${JSON.stringify(res.json())}`);

step(7, 'Device sends a heartbeat');
res = await app.inject({
  method: 'POST',
  url: '/api/device/heartbeat',
  headers: DEV,
  payload: { fw_version: '0.1.0-sim', battery_pct: 92, charging: false, rssi: -61, paper_ok: true },
});
console.log(`    heartbeat: ${JSON.stringify(res.json())}`);
res = await app.inject({ method: 'GET', url: `/api/portal/devices?location_id=${locId}`, headers: STAFF });
console.log(`    portal registry now shows: ${JSON.stringify(res.json())}`);

console.log('\nSimulated device lifecycle complete — every step ran against the real backend code.');
await app.close();
