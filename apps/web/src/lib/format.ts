/**
 * Display formatting.
 *
 * Small, and worth its own file because every one of these has a wrong version that
 * looks right until a real customer sees it.
 */

/**
 * Integer cents to what a person reads. `28000` -> `$280`, `28050` -> `$280.50`.
 *
 * Mirrors `formatCents` in the API deliberately rather than importing it: the API's copy
 * is inside the pricing module, and the CI guard forbids anything outside that module
 * from rendering money — including, correctly, this app. The dashboard only ever
 * *displays* a figure the API already computed; it never derives one.
 */
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** E.164 to the form an owner dials. `+61412345678` -> `0412 345 678`. */
export function phone(e164: string): string {
  const au = /^\+61(\d{9})$/.exec(e164);
  if (!au?.[1]) return e164;
  const digits = `0${au[1]}`;
  return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
}

/**
 * How long ago, in the words someone glancing at a phone uses.
 *
 * Relative rather than absolute because the only question an owner asks of a lead list is
 * "how stale is this" — and this product exists to beat whoever calls back first, so
 * "4 min" carries urgency that "2:41pm" does not.
 */
export function ago(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

/** Time of day for a transcript, in the business's local reading of it. */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
}

/** "2 bed 2 bath", or nothing. `0` is meaningful — a studio genuinely has no bedroom. */
export function rooms(bedrooms: number | null, bathrooms: number | null): string | null {
  const parts: string[] = [];
  if (bedrooms !== null) parts.push(`${bedrooms} bed`);
  if (bathrooms !== null) parts.push(`${bathrooms} bath`);
  return parts.length > 0 ? parts.join(' ') : null;
}
