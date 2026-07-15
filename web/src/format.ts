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

/** unix seconds → "JUL 13 2026" (postmark cancel line) */
export function postmarkDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    .replace(',', '')
    .toUpperCase();
}

/** "Tournament #12" → "12"; falls back to the id for unnumbered names. */
export function tournamentNo(name: string, id: number): string {
  return name.match(/#(\d+)/)?.[1] ?? String(id);
}

/** NS-perspective score with an explicit sign: 620 → "+620", -100 → "−100" */
export function signedScore(n: number): string {
  return n < 0 ? `−${-n}` : `+${n}`;
}

/** "NS vul" / "EW vul" / "Both vul" / "None vul" */
export function vulLabel(vul: { ns: boolean; ew: boolean }): string {
  if (vul.ns && vul.ew) return 'Both vul';
  if (vul.ns) return 'NS vul';
  if (vul.ew) return 'EW vul';
  return 'None vul';
}
