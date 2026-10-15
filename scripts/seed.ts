// Seeds a demo merchant / location / tables for local development.
// Requires ENCRYPTION_KEY (see .env.example).
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/migrate.js';
import { query } from '../src/db.js';
import { config } from '../src/config.js';
import { encryptSecret } from '../src/crypto.js';

await migrate();

await query(
  `INSERT INTO merchants(id, pos_type, external_merchant_ref, square_merchant_id, access_token_enc, refresh_token_enc)
   VALUES ('demo-merchant','square','sandbox-dev','sandbox-dev',$1,$2)
   ON CONFLICT (pos_type, external_merchant_ref) DO NOTHING`,
  [encryptSecret('dev-placeholder'), encryptSecret('dev-placeholder')],
);

const sqLoc = config.squareLocationId || 'SET_SQUARE_LOCATION_ID';
await query(
  `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
   VALUES ('demo-location','demo-merchant','square',$1,$1,'Demo Restaurant','USD')
   ON CONFLICT (square_location_id) DO NOTHING`,
  [sqLoc],
);

for (const name of ['T1', 'T2', 'T3', 'T4']) {
  await query(
    `INSERT INTO tables(id, location_id, name, qr_token, state)
     VALUES ($1,'demo-location',$2,$3,'FREE')
     ON CONFLICT DO NOTHING`,
    [randomUUID(), name, randomUUID().replace(/-/g, '')],
  );
}

const tables = await query<{ name: string; qr_token: string }>(
  `SELECT name, qr_token FROM tables WHERE location_id = 'demo-location' ORDER BY name`,
);
console.log('Seeded tables (guest links):');
for (const t of tables.rows) console.log(`  ${t.name}: ${config.appUrl}/t/${t.qr_token}`);
console.log(`Staff dashboard: ${config.appUrl}/dashboard`);
process.exit(0);
