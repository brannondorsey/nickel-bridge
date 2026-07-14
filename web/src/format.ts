/** Tiny display formatters shared across screens. */

/** 1 → "1ST", 2 → "2ND", 3 → "3RD", 11–13 → "…TH", 21 → "21ST" */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  const rem10 = n % 10;
  const suffix =
    rem100 >= 11 && rem100 <= 13 ? 'TH' : rem10 === 1 ? 'ST' : rem10 === 2 ? 'ND' : rem10 === 3 ? 'RD' : 'TH';
  return `${n}${suffix}`;
}

/** unix seconds → "Jul 9" */
export function shortDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Time-of-day word for the Home greeting. */
export function timeGreeting(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}
