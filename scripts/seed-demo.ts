// One-shot demo bootstrap for a fresh database:
// creates a merchant + location (linked to a Square location) and a portal
// owner user. Prints the generated password ONCE — save it; only the hash
// is stored.
//
// Usage:
//   SQUARE_LOCATION_ID=<sq-loc> tsx scripts/seed-demo.ts <owner-email> [restaurant-name]
//
// All other config comes from the environment (DATABASE_URL, ENCRYPTION_KEY).
import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from '../src/migrate.js';
import { query } from '../src/db.js';
import { hashPassword } from '../src/crypto.js';
import { config } from '../src/config.js';

const [emailArg, restaurantName = 'Demo Restaurant'] = process.argv.slice(2);
if (!emailArg) {
  console.error('Usage: tsx scripts/seed-demo.ts <owner-email> [restaurant-name]');
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();
const squareLocationId = config.squareLocationId;
if (!squareLocationId) {
  console.error('SQUARE_LOCATION_ID must be set (your Square sandbox location for the demo).');
  process.exit(1);
}

await migrate();

// Merchant (one row per Square merchant; demo uses a single sandbox merchant).
let merchantId: string;
const m = await query<{ id: string }>(
  `SELECT id FROM merchants WHERE square_merchant_id = 'demo-merchant'`,
);
if (m.rowCount === 0) {
  merchantId = randomUUID();
  await query(
    `INSERT INTO merchants(id, square_merchant_id, access_token_enc, refresh_token_enc)
     VALUES ($1, 'demo-merchant', '', '')`,
    [merchantId],
  );
} else {
  merchantId = m.rows[0].id;
}

// Location linked to the Square sandbox location.
let locationId: string;
const l = await query<{ id: string }>(
  `SELECT id FROM locations WHERE square_location_id = $1`,
  [squareLocationId],
);
if (l.rowCount === 0) {
  locationId = randomUUID();
  await query(
    `INSERT INTO locations(id, merchant_id, square_location_id, name, currency)
     VALUES ($1, $2, $3, $4, 'CAD')`,
    [locationId, merchantId, squareLocationId, restaurantName],
  );
} else {
  locationId = l.rows[0].id;
}

// Owner user (upsert: re-running resets the password).
const password = randomBytes(12).toString('base64url');
const password_hash = await hashPassword(password);
await query(
  `INSERT INTO portal_users(id, email, password_hash, role, location_id)
   VALUES ($1, $2, $3, 'owner', $4)
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, location_id = EXCLUDED.location_id`,
  [randomUUID(), email, password_hash, locationId],
);

console.log('Demo restaurant ready (password shown ONCE — save it now):');
console.log(`  restaurant: ${restaurantName}`);
console.log(`  location:   ${locationId}`);
console.log(`  email:      ${email}`);
console.log(`  password:   ${password}`);
process.exit(0);
