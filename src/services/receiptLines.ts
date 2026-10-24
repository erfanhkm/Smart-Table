// Server-side receipt lines for the STT-101's 58mm thermal printer
// (32 columns). Used by the guest receipt-print route; the device pulls
// these lines verbatim via GET /api/device/print-jobs and prints them.
// Amounts mirror the emailed receipt: the items of the payment's own
// check, then what THIS payment settled (amount + tip).

export interface ReceiptLineInput {
  restaurantName: string;
  tableName: string;
  items: { name: string; quantity: number; amountCents: number }[];
  amountCents: number; // this payment, excluding tip
  tipCents: number;
  currency?: string;
  paidAt: string; // pre-formatted date/time line
}

const WIDTH = 32;
const RULE = '-'.repeat(WIDTH);

function money(cents: number, currency: string): string {
  const sym = !currency || currency === 'CAD' ? '$' : `${currency} `;
  return `${sym}${(cents / 100).toFixed(2)}`;
}

function centered(text: string): string {
  const t = text.slice(0, WIDTH);
  const pad = Math.max(0, Math.floor((WIDTH - t.length) / 2));
  return ' '.repeat(pad) + t;
}

function twoCol(left: string, right: string): string[] {
  if (left.length + 1 + right.length <= WIDTH) {
    return [left + ' '.repeat(WIDTH - left.length - right.length) + right];
  }
  return [left.slice(0, WIDTH), ' '.repeat(Math.max(0, WIDTH - right.length)) + right];
}

export function buildReceiptLines(input: ReceiptLineInput): string[] {
  const currency = input.currency || 'CAD';
  const lines: string[] = [];
  lines.push(centered(input.restaurantName || 'Smart Table'));
  lines.push(centered(`Table ${input.tableName}`));
  lines.push(RULE);
  for (const item of input.items) {
    lines.push(...twoCol(`${item.quantity} x ${item.name}`, money(item.amountCents, currency)));
  }
  if (input.items.length > 0) lines.push(RULE);
  lines.push(...twoCol('Paid', money(input.amountCents, currency)));
  if (input.tipCents > 0) lines.push(...twoCol('Tip', money(input.tipCents, currency)));
  lines.push(...twoCol('Total', money(input.amountCents + input.tipCents, currency)));
  lines.push(RULE);
  lines.push(input.paidAt.slice(0, 80));
  lines.push(centered('Thank you!'));
  return lines;
}
