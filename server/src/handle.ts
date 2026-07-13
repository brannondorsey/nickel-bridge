const MAX_LENGTH = 24;

// Blocks control (Cc), format (Cf), surrogate (Cs), and private-use (Co) code
// points — this is what keeps "allow any Unicode" from becoming a spoofing or
// injection vector: no null/newline/tab bytes, no bidi override/embedding
// characters, no zero-width joiners or BOM, no lone surrogates. Ordinary
// letters, digits, punctuation, symbols, and emoji from any script are fine.
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u;

export type HandleValidation = { ok: true; handle: string; key: string } | { ok: false; error: string };

export function validateHandle(raw: string): HandleValidation {
  if (typeof raw !== 'string') return { ok: false, error: 'handle is required' };
  const handle = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!handle) return { ok: false, error: 'handle is required' };
  if (FORBIDDEN_CHARS.test(handle)) return { ok: false, error: 'handle contains an unsupported character' };
  if ([...handle].length > MAX_LENGTH) return { ok: false, error: `handle must be ${MAX_LENGTH} characters or fewer` };
  return { ok: true, handle, key: handle.toLowerCase() };
}
