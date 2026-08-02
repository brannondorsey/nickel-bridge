const MAX_LENGTH = 24;

// Blocks control (Cc), format (Cf), surrogate (Cs), and private-use (Co) code
// points — this is what keeps "allow any Unicode" from becoming a spoofing or
// injection vector: no null/newline/tab bytes, no bidi override/embedding
// characters, no zero-width joiners or BOM, no lone surrogates. Ordinary
// letters, digits, punctuation, symbols, and emoji from any script are fine.
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u;

/**
 * Cross-script lookalikes, folded to their Latin twin for the UNIQUENESS KEY
 * only — never for the handle anyone sees.
 *
 * The problem this closes: "any Unicode handle" is a deliberate design choice,
 * and lowercasing does nothing about a Cyrillic `а` (U+0430) standing in for a
 * Latin `a`. Two handles that no reader can tell apart produced two different
 * keys, so both passed the unique index and both could sit on the ladder. Being
 * mistaken for another player is a social attack rather than a privilege one —
 * nothing here is identity-bound, and a profile is only readable by someone
 * signed in — but the ladder and the field are exactly where a handle does its
 * work, and a lookalike is worth nothing to an honest registrant.
 *
 * Case-mapped BEFORE lowercasing, which is why both cases are listed: Cyrillic
 * `В` lowercases to `в`, a shape that no longer resembles `b` at all, so a
 * lowercase-first fold would miss `Вob` — the exact form an impersonator types.
 *
 * Curated rather than complete, and honestly so. The full answer is UTS-39's
 * confusable-skeleton table (thousands of mappings, regenerated per Unicode
 * release); this is the cross-script subset that covers the ASCII-lookalike
 * attack anyone can type — Cyrillic and Greek — on top of the compatibility
 * folding NFKC already does for fullwidth (`ａ`) and mathematical (`𝐚`) letters.
 * Two things it does NOT claim to catch, so nobody reads more into it than is
 * here: within-script confusions (`rn` for `m`, `l` for `I`), which no table
 * settles, and lookalikes from scripts not listed. Swapping this map for a
 * generated UTS-39 skeleton is a drop-in change if that day comes.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  А: 'A', В: 'B', Е: 'E', Ѕ: 'S', І: 'I', Ј: 'J', К: 'K', М: 'M', Н: 'H',
  О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', Ԛ: 'Q', Ԝ: 'W',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', ѕ: 's', і: 'i',
  ј: 'j', ԁ: 'd', һ: 'h', ӏ: 'l', ԛ: 'q', ԝ: 'w',
  // Greek
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N',
  Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', ο: 'o', ρ: 'p', ι: 'i', ϲ: 'c',
};

const CONFUSABLE_CHARS = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'gu');

/**
 * The case-insensitive uniqueness key for a handle.
 *
 * NFKC rather than the NFC the display form gets: compatibility normalization
 * is what collapses fullwidth and mathematical alphabets (`Ｍａｒｇａｒｅｔ`,
 * `𝐌𝐚𝐫𝐠𝐚𝐫𝐞𝐭`) onto plain letters, which is the same impersonation in a
 * different disguise. It can also expand a character into whitespace (NBSP
 * becomes a space), so the collapse runs again here rather than trusting the
 * display form's.
 *
 * Note what changing this does NOT do: existing rows keep the keys they were
 * stored with, since the column is written at registration. A new lookalike of
 * an existing plain-Latin handle now collides and is refused — the case that
 * matters — while a plain-Latin twin of an existing exotic handle would not.
 * Backfilling would mean recomputing keys that can now collide with each other,
 * against a UNIQUE index, i.e. a migration that can fail on live data; the
 * asymmetry is the cheaper trade.
 */
export function handleKey(handle: string): string {
  return handle
    .normalize('NFKC')
    .replace(CONFUSABLE_CHARS, (c) => CONFUSABLES[c])
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export type HandleValidation = { ok: true; handle: string; key: string } | { ok: false; error: string };

export function validateHandle(raw: string): HandleValidation {
  if (typeof raw !== 'string') return { ok: false, error: 'handle is required' };
  const handle = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!handle) return { ok: false, error: 'handle is required' };
  if (FORBIDDEN_CHARS.test(handle)) return { ok: false, error: 'handle contains an unsupported character' };
  if ([...handle].length > MAX_LENGTH) return { ok: false, error: `handle must be ${MAX_LENGTH} characters or fewer` };
  const key = handleKey(handle);
  // NFKC can strip a handle to nothing the NFC display form still had (a lone
  // compatibility character), and an empty key would collide with every other
  // empty one on the unique index rather than being the free name it looks like.
  if (!key) return { ok: false, error: 'handle contains an unsupported character' };
  return { ok: true, handle, key };
}
