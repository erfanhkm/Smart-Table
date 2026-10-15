// Seeds a portal owner user for local development / pilot.
// Usage: tsx scripts/seed-portal-user.ts <email> <location_id> [role]
// Prints the generated password ONCE — save it; it is stored hashed.
import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from '../src/migrate.js';
import { query } from '../src/db.js';
import { hashPassword } from '../src/crypto.js';

const [emailArg, locationId, role = 'owner'] = process.argv.slice(2);
if (!emailArg || !locationId) {
  console.error('Usage: tsx scripts/seed-portal-user.ts <email> <location_id> [role]');
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();

await migrate();

const loc = await query(`SELECT id FROM locations WHERE id = $1`, [locationId]);
if (loc.rowCount === 0) {
  console.error(`unknown location_id: ${locationId}`);
  process.exit(1);
}

const password = randomBytes(12).toString('base64url');
const password_hash = await hashPassword(password);

await query(
  `INSERT INTO portal_users(id, email, password_hash, role, location_id)
   VALUES ($1, $2, $3, $4, $5)
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, location_id = EXCLUDED.location_id`,
  [randomUUID(), email, password_hash, role, locationId],
);

console.log('Portal user ready (password shown ONCE — save it now):');
console.log(`  email:    ${email}`);
console.log(`  password: ${password}`);
console.log(`  location: ${locationId}  role: ${role}`);
process.exit(0);
