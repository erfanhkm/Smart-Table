// Email service for receipts (v0.2).
//
// Provider: Resend (https://resend.com). Set RESEND_API_KEY +
// RECEIPT_FROM_EMAIL (e.g. receipts@smarttablepay.com) to enable.
// Without a key, sends are logged and skipped (dev mode) — the endpoint
// still returns ok so the UI doesn't break.
import { config } from '../config.js';

export interface ReceiptData {
  restaurantName: string;
  tableName: string;
  items: { name: string; quantity: number; amountCents: number }[];
  totalCents: number;
  currency: string;
  paidAt: string;
}

function receiptHtml(r: ReceiptData): string {
  const rows = r.items
    .map(
      (i) =>
        `<tr><td>${escapeHtml(i.name)}</td><td align="right">${i.quantity}</td><td align="right">${money(i.amountCents, r.currency)}</td></tr>`,
    )
    .join('');
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;">
<h2>${escapeHtml(r.restaurantName)}</h2>
<p>Table ${escapeHtml(r.tableName)} · ${escapeHtml(r.paidAt)}</p>
<table width="100%" cellpadding="6" style="border-collapse:collapse;">
<tr style="border-bottom:2px solid #ddd;"><th align="left">Item</th><th align="right">Qty</th><th align="right">Amount</th></tr>
${rows}
<tr style="border-top:2px solid #ddd;font-weight:bold;"><td colspan="2">Total</td><td align="right">${money(r.totalCents, r.currency)}</td></tr>
</table>
<p style="color:#888;font-size:12px;">Powered by Smart Table</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return (cents / 100).toFixed(2) + ' ' + currency;
  }
}

export async function sendReceiptEmail(to: string, receipt: ReceiptData): Promise<{ sent: boolean; skipped?: string }> {
  const apiKey = config.resendApiKey;
  const from = config.receiptFromEmail;
  if (!apiKey || !from) {
    console.log(`[email] RESEND_API_KEY not set — skipping receipt email to ${to}`);
    return { sent: false, skipped: 'email provider not configured' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      subject: `Your receipt from ${receipt.restaurantName}`,
      html: receiptHtml(receipt),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API ${res.status}: ${body.slice(0, 200)}`);
  }
  return { sent: true };
}

// ---------------------------------------------------------------------------
// v0.8.4: owner-demo access-request notification. Sent to Erfan with the
// prospect's FULL details as submitted on smarttablepay.com/owner-demo;
// reply-to is the prospect's own email so approval is one reply away.
// Same Resend plumbing as receipts; without a key the send is skipped
// (the request itself is already stored in demo_access_requests).
// ---------------------------------------------------------------------------
export interface DemoAccessData {
  fullName: string;
  restaurantName: string;
  email: string;
  phone: string;
  city: string;
  posSystem?: string | null;
  locationsCount?: number | null;
  tablesCount?: number | null;
  website?: string | null;
  message?: string | null;
  submittedAt: string;
}

export async function sendDemoAccessEmail(to: string, d: DemoAccessData): Promise<{ sent: boolean; skipped?: string }> {
  const apiKey = config.resendApiKey;
  const from = config.receiptFromEmail;
  if (!apiKey || !from) {
    console.log(`[email] RESEND_API_KEY not set — skipping demo-access notification for ${d.restaurantName}`);
    return { sent: false, skipped: 'email provider not configured' };
  }
  const rows: [string, string][] = [
    ['Full name', d.fullName],
    ['Restaurant', d.restaurantName],
    ['Email', d.email],
    ['Phone', d.phone],
    ['City', d.city],
    ['POS system', d.posSystem ?? '—'],
    ['Locations', d.locationsCount != null ? String(d.locationsCount) : '—'],
    ['Tables (approx.)', d.tablesCount != null ? String(d.tablesCount) : '—'],
    ['Website', d.website ?? '—'],
    ['Message', d.message ?? '—'],
    ['Submitted', d.submittedAt],
  ];
  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px;">
<h2>New Smart Table owner-demo access request</h2>
<table width="100%" cellpadding="6" style="border-collapse:collapse;">
${rows.map(([k, v]) => `<tr style="border-bottom:1px solid #eee;"><td style="color:#666;width:150px;">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('\n')}
</table>
<p>Reply to this email to answer the prospect directly (reply-to is their address). The request is also stored in the database (demo_access_requests, status: pending).</p>
<p style="color:#888;font-size:12px;">Smart Table — smarttablepay.com/owner-demo</p>
</body></html>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      reply_to: d.email,
      subject: `Owner demo access request — ${d.restaurantName} (${d.fullName})`,
      html,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API ${res.status}: ${body.slice(0, 200)}`);
  }
  return { sent: true };
}
