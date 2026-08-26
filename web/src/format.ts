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

/**
 * Same as shortDate, but rendered in UTC — for a UTC calendar-day bucket
 * (e.g. DayGrid's dateToUnix), not a genuine instant in time. shortDate's
 * default local-timezone rendering would otherwise shift a UTC-midnight
 * bucket back a day for every viewer west of UTC.
 */
export function shortDateUTC(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** unix seconds → "9:41p" / "7:58a", in the viewer's own timezone. */
export function clockTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`;
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

/**
 * How a crossing is NAMED to a player, and the one place that decides it.
 *
 * `tournaments.number` is the display sequence and `tournaments.id` is the row
 * address — deliberately different values (see CONTRIBUTING's "A crossing's
 * number is its own sequence, not its row id"), so production's id 126 wears
 * "#105". This used to regex `#(\d+)` back out of the tournament NAME, which
 * was wrong in the direction that fails silently: any name without a `#` —
 * every rehearsal, whose name reads "Rehearsal — Board 1, from Trick 10" —
 * fell through to the raw id and printed an address where a number belonged.
 * The server now sends the column, so the derivation is gone.
 *
 * The id fallback survives for rows that genuinely carry no number (rehearsal
 * and exhibit kinds are NULL by design). Nothing standard should reach it: a
 * standard crossing missing its number is a bug in createCrossing, not a
 * display case, and printing its id is the least-worst way to still render.
 */
export function tournamentNo(number: number | null | undefined, id: number): string {
  return number != null ? String(number) : String(id);
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
