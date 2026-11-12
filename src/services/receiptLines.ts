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
// merchant-controlled, so strip every control character at job-creation
// time (and from the formatter's own inputs, whose column math counts
// characters — a control byte is not a column). v0.10.10 (C3-10 L-1):
// newline is stripped too — left in, one logical line could print as
// several (a forged total under a real one). It becomes a space so
// adjacent words stay separate.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

export function stripControlChars(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ').replace(CONTROL_CHARS, '');
}

/**
 * Terminal-style display width of a string, by code point (never splitting
 * a surrogate pair): combining marks count 0, East-Asian wide/fullwidth
 * code points and emoji count 2, everything else counts 1. The thermal
 * printer's font metrics are not knowable here; this is the standard
 * wcwidth approximation and is strictly safer than UTF-16 .length, which
 * under-counts CJK (columns overflow) and can slice a surrogate pair.
 */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0) continue;
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue;
    if (/\p{M}/u.test(ch)) continue;
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK radicals … Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
      (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
      (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
      (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext. B and beyond
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** Truncate to at most `max` display columns, on a code-point boundary. */
function truncateDisplay(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (w + cw > max) break;
    out += ch;
    w += cw;
  }
  return out;
}

export function sanitizePrintLines(lines: string[]): string[] {
  return lines.map((l) => stripControlChars(l));
}

const WIDTH = 32;
const RULE = '-'.repeat(WIDTH);

function money(cents: number, currency: string): string {
  const clean = stripControlChars(currency || '');
  const sym = !clean || clean === 'CAD' ? '$' : `${clean} `;
  return `${sym}${(cents / 100).toFixed(2)}`;
}

function centered(text: string): string {
  const t = truncateDisplay(text, WIDTH);
  const pad = Math.max(0, Math.floor((WIDTH - displayWidth(t)) / 2));
  return ' '.repeat(pad) + t;
}

function twoCol(left: string, right: string): string[] {
  const lw = displayWidth(left);
  const rw = displayWidth(right);
  if (lw + 1 + rw <= WIDTH) {
    return [left + ' '.repeat(WIDTH - lw - rw) + right];
  }
  return [
    truncateDisplay(left, WIDTH),
    ' '.repeat(Math.max(0, WIDTH - rw)) + truncateDisplay(right, WIDTH),
  ];
}

export function buildReceiptLines(input: ReceiptLineInput): string[] {
  const currency = input.currency || 'CAD';
  const lines: string[] = [];
  lines.push(centered(stripControlChars(input.restaurantName || 'Smart Table')));
  lines.push(centered(`Table ${stripControlChars(input.tableName)}`));
  lines.push(RULE);
  // C3-10 L-3 (aligning with the C3-8 M1 guest-app rule): the formatter
  // receives ALL of the check's items but only THIS payment's amount. When
  // the two do not reconcile — a partial / split payment — itemizing the
  // full check over a partial "Paid" line misleads the guest about what
  // they bought. Print the single share line the guest app shows instead.
  const itemsTotal = input.items.reduce((sum, i) => sum + i.amountCents, 0);
  if (input.items.length > 0 && itemsTotal === input.amountCents) {
    for (const item of input.items) {
      lines.push(...twoCol(`${item.quantity} x ${stripControlChars(item.name)}`, money(item.amountCents, currency)));
    }
    lines.push(RULE);
  } else if (input.items.length > 0) {
    lines.push(...twoCol('Your share of the check', money(input.amountCents, currency)));
    lines.push(RULE);
  }
  lines.push(...twoCol('Paid', money(input.amountCents, currency)));
  if (input.tipCents > 0) lines.push(...twoCol('Tip', money(input.tipCents, currency)));
  lines.push(...twoCol('Total', money(input.amountCents + input.tipCents, currency)));
  lines.push(RULE);
  lines.push(truncateDisplay(stripControlChars(input.paidAt), 80));
  lines.push(centered('Thank you!'));
  // C3-10 L-2: the formatter sanitizes its OWN output as a final pass, so
  // no field (currency, quantity coercion, a future caller) can smuggle a
  // control byte past the per-field stripping above.
  return sanitizePrintLines(lines);
}
