export const CENTRAL_TIME_ZONE = 'America/Chicago';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dateTime = new Intl.DateTimeFormat('en-US', {
  timeZone: CENTRAL_TIME_ZONE,
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const dateTimeWithYear = new Intl.DateTimeFormat('en-US', {
  timeZone: CENTRAL_TIME_ZONE,
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const yearOnly = new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL_TIME_ZONE, year: 'numeric' });
const shortDate = new Intl.DateTimeFormat('en-US', {
  timeZone: CENTRAL_TIME_ZONE, month: 'long', day: 'numeric', year: 'numeric',
});

export function money(cents: number): string {
  return Number.isFinite(cents) ? dollars.format(cents / 100) : 'n/a';
}

export function signedMoney(cents: number): string {
  return `${cents > 0 ? '+' : ''}${money(cents)}`;
}

export function timestamp(value: string | null | undefined, now = new Date()): string {
  if (!value) return 'Not confirmed';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Not confirmed';
  return (yearOnly.format(date) === yearOnly.format(now) ? dateTime : dateTimeWithYear).format(date);
}

export function calendarDate(value: string | null | undefined): string {
  if (!value) return 'Not yet started';
  // A calendar date has no timezone; midday UTC preserves its date in Central time.
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  return Number.isFinite(date.getTime()) ? shortDate.format(date) : 'Not confirmed';
}

export function age(value: string | null | undefined, now = Date.now()): string {
  if (!value) return 'Awaiting first sync';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'Not confirmed';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return 'Updated just now';
  const unit = (count: number, singular: string) => `Updated ${count} ${count === 1 ? singular : `${singular}s`} ago`;
  if (minutes < 60) return unit(minutes, 'minute');
  if (minutes < 1440) return unit(Math.floor(minutes / 60), 'hour');
  return unit(Math.floor(minutes / 1440), 'day');
}

export function americanOdds(decimal: number): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return 'Unpriced';
  const value = Math.round(decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1));
  return value > 0 ? `+${value}` : String(value);
}

export function priceLabel(odds: number | null): string {
  if (odds === null) return 'Price unconfirmed';
  if (!Number.isFinite(odds) || odds <= 1) return 'Unpriced';
  return `${americanOdds(odds)} · ${(100 / odds).toFixed(1)}% implied`;
}

export function formatMultiple(decimal: number | null | undefined, digits: number, missing: string): string {
  if (decimal === null || decimal === undefined) return missing;
  if (!Number.isFinite(decimal)) return 'Unpriced';
  return `${decimal.toFixed(digits)}×`;
}

export function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function progress(availableCents: number, outstandingCents: number, targetCents: number): number {
  if (![availableCents, outstandingCents, targetCents].every(Number.isFinite) || targetCents <= 0) return 0;
  return Math.min(100, Math.max(0, ((availableCents + outstandingCents) / targetCents) * 100));
}
