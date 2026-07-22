#!/usr/bin/env node
/**
 * Regenerates web/src/glossary/deep.json — the glossary's "deep reference":
 * the full Wikipedia "Glossary of contract bridge terms" list (CC BY-SA 4.0),
 * adapted down to lightweight one-liner entries that back the Glossary page's
 * "show deep reference" toggle and the search fallthrough. Core-tier terms
 * (and their aliases) from web/src/glossary/terms.ts are excluded so the two
 * ledgers never show duplicates.
 *
 * Usage:
 *   node tools/gen_glossary_deep.mjs [saved-page.html]
 *
 * With no argument it fetches the live article HTML from Wikipedia's REST API
 * (network-restricted environments can `curl -o page.html <SOURCE_URL>` and
 * pass the file instead). Output is checked in; rerun only when refreshing
 * the reference content, and eyeball the diff — the one-liners ship verbatim.
 *
 * Adaptation rules ("adapted" per the CC BY-SA credit): strip markup and
 * citations, keep the first sentence (with an abbreviation guard so "e.g." /
 * "i.e." don't truncate), cap at ~220 chars. Suit glyphs survive untouched —
 * the web's SuitText colors them. "See <other term>." cross-reference entries
 * are kept as-is; every row links to its own anchor on Wikipedia for the rest.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://en.wikipedia.org/api/rest_v1/page/html/Glossary_of_contract_bridge_terms';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../web/src/glossary/deep.json');

const { TERMS } = await import('../web/src/glossary/terms.ts');

/** Fold a display name down to its identity for core-vs-deep dedupe. */
function normalizeName(s) {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ') // "ruff (verb)" ≡ "ruff"
    .replace(/[^a-z0-9♠♥♦♣]+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

function stripHtml(s) {
  return decodeEntities(
    s
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, '')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\[\d+\]|\[[a-z]\]/gi, '') // stray citation markers
    .replace(/\s+/g, ' ')
    .trim();
}

/** First sentence, guarded against common abbreviations, hard-capped. */
function oneLiner(text) {
  const ABBREV = /(?:e\.g|i\.e|cf|vs|etc|viz|approx|no|St)\.$/i;
  let cut = text.length;
  const re = /\.[)"'’”]*\s+(?=[A-Z0-9(♠♥♦♣"'‘“])/g;
  let m;
  while ((m = re.exec(text))) {
    const upto = text.slice(0, m.index + 1);
    if (upto.length < 40) continue; // "N. of a suit" style openings
    if (ABBREV.test(upto)) continue;
    cut = m.index + m[0].trimEnd().length;
    break;
  }
  let out = text.slice(0, cut).trim();
  if (out.length > 220) {
    const clipped = out.slice(0, 220);
    out = clipped.slice(0, Math.max(clipped.lastIndexOf(' '), 180)) + '…';
  }
  return out;
}

async function loadHtml() {
  const file = process.argv[2];
  if (file) return readFileSync(file, 'utf8');
  const res = await fetch(SOURCE_URL, { headers: { 'user-agent': 'nickel-bridge-glossary-tool (see repo)' } });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
}

const html = await loadHtml();

// Walk <dt>/<dd> elements in document order. Consecutive <dt>s (synonym
// headwords) all take the next <dd> as their definition.
const tokens = [...html.matchAll(/<(dt|dd)\b([^>]*)>([\s\S]*?)<\/\1>/g)];
const raw = [];
let pendingDts = [];
for (const [, tag, attrs, body] of tokens) {
  if (tag === 'dt') {
    // Real fragment anchors are the glossary template's inner <span id>s;
    // the dt's own id (and inner link ids) are Parsoid-generated "mw…" noise
    // that doesn't resolve on the rendered article. No template anchor ⇒
    // link to the article top (empty anchor).
    const ids = [...(attrs + body).matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const term = stripHtml(body);
    // Fall back to the article's per-letter section anchor when the entry
    // has no template anchor of its own.
    const letter = /^[A-Za-z]/.test(term) ? term[0].toUpperCase() : '';
    const id = ids.find((v) => !/^mw[\w-]*$/.test(v)) ?? letter;
    if (term) pendingDts.push({ term, anchor: id });
  } else {
    const def = oneLiner(stripHtml(body));
    if (def) for (const dt of pendingDts) raw.push({ ...dt, def });
    pendingDts = [];
  }
}

const core = new Set();
for (const t of TERMS) {
  core.add(normalizeName(t.term));
  for (const a of t.aliases ?? []) core.add(normalizeName(a));
}

const seen = new Set();
const entries = [];
for (const e of raw) {
  const key = normalizeName(e.term);
  if (!key || core.has(key) || seen.has(key)) continue;
  if (e.def.length < 8) continue; // markup-only stubs
  seen.add(key);
  entries.push({ term: e.term, def: e.def, anchor: e.anchor });
}
entries.sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }));

writeFileSync(
  OUT,
  JSON.stringify({ source: SOURCE_URL, license: 'CC BY-SA 4.0', entries }, null, 1) + '\n',
);
console.log(`dt/dd pairs: ${raw.length}, deduped vs core+self: ${raw.length - entries.length}, kept: ${entries.length}`);
console.log(`wrote ${OUT}`);
