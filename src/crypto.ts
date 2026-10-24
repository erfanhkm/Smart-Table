// AES-256-GCM secret encryption (Square OAuth tokens at rest) and
// Square webhook signature verification (HMAC-SHA256).
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

function encKey(): Buffer {
  const hex = config.encryptionKeyHex;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate with: openssl rand -hex 32');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), ct.toString('base64'), cipher.getAuthTag().toString('base64')].join('.');
}

export function decryptSecret(enc: string): string {
  const parts = enc.split('.');
  if (parts.length !== 3) throw new Error('malformed encrypted secret');
  const [ivB64, ctB64, tagB64] = parts;
  // F5-20: an empty PLAINTEXT is legitimate (a stored credential with no
  // refresh token encrypts ''), and its ciphertext segment is empty too.
  // The old truthiness check rejected it as malformed, so such credentials
  // threw on every decrypt. Only missing segments are malformed.
  if (ivB64 === undefined || ctB64 === undefined || tagB64 === undefined || !ivB64 || !tagB64) {
    throw new Error('malformed encrypted secret');
  }
  const tag = Buffer.from(tagB64, 'base64');
  // F5-7 (partial): pin the GCM auth tag at the full 16 bytes — Node
  // otherwise accepts truncated tags in some versions, weakening the
  // integrity guarantee.
  if (tag.length !== 16) throw new Error('malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

// Square signs webhooks as: base64(HMAC_SHA256(signatureKey, notificationUrl + rawBody))
export function verifySquareWebhook(rawBody: string, signature: string, notificationUrl: string): boolean {
  if (!config.squareWebhookKey) return false; // dev only: no key configured
  const expected = createHmac('sha256', config.squareWebhookKey).update(notificationUrl + rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Portal user password hashing (scrypt) ----
// Stored format: "scrypt$<salt-hex>$<hash-hex>" (salt 16 bytes, hash 64 bytes).
import { scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scryptCb);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  // F5-21 (partial): NFC-normalize so the same password typed with composed
  // vs decomposed characters (different keyboards/OSes) hashes identically.
  // (Cost-parameter versioning stays with the A-11 deferral — changing the
  // KDF cost without storing the params would invalidate existing hashes.)
  const hash = (await scryptAsync(password.normalize('NFC'), salt, 64)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = (await scryptAsync(password.normalize('NFC'), salt, 64)) as Buffer;
  return timingSafeEqual(actual, expected);
}
