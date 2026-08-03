import { describe, expect, it } from 'vitest';
import { handleKey, validateHandle } from '../src/handle.js';

/**
 * Handle validation and, mostly, the uniqueness KEY — the value the partial
 * unique index on users.handle_key is built from (db.ts). A pure unit test:
 * handle.ts imports nothing, and the claim path that uses it is covered by the
 * API suite.
 */
const key = (raw: string) => {
  const result = validateHandle(raw);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(raw)} to validate: ${result.error}`);
  return result.key;
};

describe('validateHandle', () => {
  it('keeps the display handle as typed, trimming and collapsing whitespace only', () => {
    const result = validateHandle('  Margaret   Rutherford ');
    expect(result).toMatchObject({ ok: true, handle: 'Margaret Rutherford' });
  });

  it('refuses control, format, surrogate and private-use characters', () => {
    for (const raw of ['null\u0000byte', 'bidi\u202Eflip', 'zero\u200Bwidth', 'private\uE000use']) {
      expect(validateHandle(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it('refuses the empty handle and anything past the length cap', () => {
    expect(validateHandle('   ').ok).toBe(false);
    expect(validateHandle('x'.repeat(25)).ok).toBe(false);
    expect(validateHandle('x'.repeat(24)).ok).toBe(true);
  });
});

describe('the uniqueness key', () => {
  it('folds case, as it always has', () => {
    expect(key('Margaret')).toBe(key('mArGaReT'));
  });

  /**
   * The impersonation this closes. Every one of these renders identically to
   * "Margaret" on the ladder; before the fold each produced its own key, so
   * each could be registered alongside the real one.
   */
  it('folds cross-script lookalikes onto their Latin twin', () => {
    const real = key('Margaret');
    expect(key('Mаrgаret')).toBe(real); // Cyrillic а (U+0430)
    expect(key('Μargaret')).toBe(real); // Greek capital Mu
    expect(key('ΜаrgаrеТ')).toBe(real); // both scripts, mixed case
    expect(key('Ｍａｒｇａｒｅｔ')).toBe(real); // fullwidth, folded by NFKC
    expect(key('𝐌𝐚𝐫𝐠𝐚𝐫𝐞𝐭')).toBe(real); // mathematical bold, likewise
  });

  it('folds the uppercase forms too, not just what lowercasing leaves behind', () => {
    // Cyrillic В lowercases to в, which resembles nothing in Latin — so a
    // fold applied after lowercasing would miss exactly the form an
    // impersonator types.
    expect(key('Вob')).toBe(key('Bob'));
    expect(key('Неnry')).toBe(key('Henry'));
  });

  it('folds the lowercase-only lookalikes that have no uppercase twin here', () => {
    // Greek ν (nu) reads as a Latin v; its uppercase Ν is already mapped as N,
    // so the pair only collides if both cases are listed.
    expect(key('Olivia')).toBe(key('Oliνia'));
  });

  it('leaves genuinely different names alone', () => {
    expect(key('Margarete')).not.toBe(key('Margaret'));
    // Accented Latin is a different name, not a disguise: nothing here strips
    // diacritics, and UTS-39's own table doesn't either.
    expect(key('Renée')).not.toBe(key('Renee'));
    // A handle written wholly in another script keeps its own identity.
    expect(key('Маргарита')).not.toBe(key('Margarita'));
  });

  it('does not touch the display handle', () => {
    const result = validateHandle('Mаrgаret'); // Cyrillic а
    expect(result).toMatchObject({ ok: true, handle: 'Mаrgаret' });
    expect((result as { key: string }).key).toBe('margaret');
  });

  it('never hands back an empty key', () => {
    // An empty key would collide with every other empty one on the unique
    // index rather than being the free name it looks like. Whitespace-only
    // input is refused before the key is derived; the guard in validateHandle
    // covers whatever NFKC alone strips to nothing.
    expect(handleKey('　')).toBe('');
    expect(validateHandle('　').ok).toBe(false);
  });
});
