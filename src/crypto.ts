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
  const [ivB64, ctB64, tagB64] = enc.split('.');
  if (!ivB64 || !ctB64 || !tagB64) throw new Error('malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
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
