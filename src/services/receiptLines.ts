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

// v0.8.14 (F11-3): receipt lines are printed by ESC/POS hardware. Any C0/C1
// control byte in a line is a printer instruction, not text: ESC starts a
// command sequence (cut, drawer kick, density), BEL rings the buzzer, the
// rest corrupt the job. POS item names and staff free-text lines are
// merchant-controlled, so strip every control character except the plain
// newline at job-creation time (and from the formatter's own inputs, whose
// column math counts characters — a control byte is not a column).
const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

export function sanitizePrintLines(lines: string[]): string[] {
  return lines.map((l) => stripControlChars(l));
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
  lines.push(centered(stripControlChars(input.restaurantName || 'Smart Table')));
  lines.push(centered(`Table ${stripControlChars(input.tableName)}`));
  lines.push(RULE);
  for (const item of input.items) {
    lines.push(...twoCol(`${item.quantity} x ${stripControlChars(item.name)}`, money(item.amountCents, currency)));
  }
  if (input.items.length > 0) lines.push(RULE);
  lines.push(...twoCol('Paid', money(input.amountCents, currency)));
  if (input.tipCents > 0) lines.push(...twoCol('Tip', money(input.tipCents, currency)));
  lines.push(...twoCol('Total', money(input.amountCents + input.tipCents, currency)));
  lines.push(RULE);
  lines.push(stripControlChars(input.paidAt).slice(0, 80));
  lines.push(centered('Thank you!'));
  return lines;
}
