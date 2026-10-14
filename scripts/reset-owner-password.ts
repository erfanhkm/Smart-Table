// One-off: reset the portal owner password in the live Neon DB.
// Usage: DATABASE_URL=... npx tsx scripts/reset-owner-password.ts <email>
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/crypto.js';
import { neon } from '@neondatabase/serverless';

const [email] = process.argv.slice(2);
if (!email || !process.env.DATABASE_URL) {
  console.error('Usage: DATABASE_URL=... tsx scripts/reset-owner-password.ts <email>');
  process.exit(1);
}
const password = randomBytes(12).toString('base64url');
const password_hash = await hashPassword(password);
const sql = neon(process.env.DATABASE_URL);
const rows = await sql`
  UPDATE portal_users SET password_hash = ${password_hash}
  WHERE email = ${email} RETURNING id, email`;
if (rows.length === 0) {
  console.error('No portal user with that email');
  process.exit(1);
}
console.log(`OK password reset for ${email}`);
console.log(`NEW_PASSWORD=${password}`);
