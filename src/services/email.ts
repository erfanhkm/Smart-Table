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
