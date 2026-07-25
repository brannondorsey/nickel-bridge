import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppHeader } from '../components/ds/AppHeader';
import { Loading } from '../components/ds/Loading';
import { SuitText } from '../components/game/SuitText';
import { Attribution } from '../glossary/Attribution';
import { useGlossary } from '../glossary/GlossaryContext';
import { deepEntryUrl, loadDeep, type DeepEntry } from '../glossary/deep';
import { LETTERS, filterCore, filterDeep, groupByLetter } from '../glossary/search';
import { TERMS, THEMES, THEME_CHIP, type GlossaryTheme } from '../glossary/terms';

/**
 * The Glossary — the core ledger of curated terms, searchable and filterable
 * by theme, with the full Wikipedia-derived deep reference one toggle (or one
 * dead-end search) away. Rows open the shared term sheet via GlossaryContext;
 * /glossary/:slug deep links seed that sheet on mount. Deep-reference rows
 * deliberately DON'T open sheets — they are lightweight one-liners whose tap
 * target is their "Read on Wikipedia" link.
 *
 * List rows render definitions through SuitText, not GlossaryProse: the row
 * itself is a button, and nesting link-buttons inside it would be invalid —
 * in-definition term links live on the sheet instead.
 */
export default function Glossary() {
  const { slug } = useParams();
  const { openTerm } = useGlossary();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState<'ALL' | GlossaryTheme>('ALL');
  const [deep, setDeep] = useState<DeepEntry[] | null>(null);
  const [deepOpen, setDeepOpen] = useState(false);
  const groupRefs = useRef(new Map<string, HTMLDivElement>());

  // /glossary/:slug is the canonical share link; normalize it into the one
  // live mechanism (?term= on /glossary, see GlossaryContext) with a replace,
  // so the sheet opens without adding a history entry to unwind.
  useEffect(() => {
    if (slug) navigate({ pathname: '/glossary', search: `?term=${slug}` }, { replace: true });
  }, [slug, navigate]);

  // Fetch the deep-reference chunk up front so the search fallthrough can
  // answer on the first keystroke; it's code-split, so this is the only
  // place the ~130KB ever loads.
  useEffect(() => {
    let alive = true;
    loadDeep().then((entries) => {
      if (alive) setDeep(entries);
    });
    return () => {
      alive = false;
    };
  }, []);

  const q = query.trim();
  const core = filterCore(TERMS, { query, theme });
  const groups = groupByLetter(core);
  const present = new Set(groups.map((g) => g.letter));
  const deepMatches = deep && q ? filterDeep(deep, query) : [];
  const fallthrough = q !== '' && core.length === 0 && deepMatches.length > 0;
  const deepRows = deepOpen ? (deep ? filterDeep(deep, query) : null) : [];

  const jumpTo = (letter: string) => {
    const el = groupRefs.current.get(letter);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <div className="glossary">
      <AppHeader context="GLOSSARY" />
      <div className="gloss-head">
        <div className="gloss-title">The Glossary</div>
        <div className="label-caps num">{TERMS.length} CORE TERMS</div>
      </div>
      <input
        className="gloss-search"
        type="search"
        placeholder="Search terms, definitions, aliases…"
        aria-label="Search the glossary"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="gloss-chips" role="group" aria-label="Filter by theme">
        {(['ALL', ...THEMES.map((t) => t.id)] as ('ALL' | GlossaryTheme)[]).map((id) => (
          <button
            key={id}
            type="button"
            className={`gloss-chip ${theme === id ? 'gloss-chip-on' : ''}`}
            aria-pressed={theme === id}
            onClick={() => setTheme(id)}
          >
            {id === 'ALL' ? 'ALL' : THEME_CHIP[id]}
          </button>
        ))}
      </div>
      <div className="gloss-main">
        <div className="gloss-list">
          {groups.map((g) => (
            <div
              key={g.letter}
              className="gloss-group"
              ref={(el) => {
                if (el) groupRefs.current.set(g.letter, el);
                else groupRefs.current.delete(g.letter);
              }}
            >
              <div className="gloss-letterhead">
                <span className="gloss-letter">{g.letter}</span>
                <span className="gloss-letterrule" />
              </div>
              {g.terms.map((t) => (
                <button key={t.slug} type="button" className="gloss-row" onClick={() => openTerm(t.slug)}>
                  <span className="gloss-row-head">
                    <span className="gloss-row-term">
                      <SuitText text={t.term} />
                    </span>
                    {t.themes.map((th) => (
                      <span key={th} className="gloss-badge">
                        {THEME_CHIP[th]}
                      </span>
                    ))}
                  </span>
                  <span className="gloss-row-def">
                    <SuitText text={t.def} />
                  </span>
                </button>
              ))}
            </div>
          ))}
          {core.length === 0 && !fallthrough ? (
            <div className="empty-note">
              {q === ''
                ? 'Nothing under this theme yet.'
                : deep === null
                  ? 'Nothing in the core ledger.'
                  : 'Nothing under that name — not even in the deep reference.'}
            </div>
          ) : null}

          {fallthrough ? (
            <>
              <div className="gloss-notice">
                Nothing in the core ledger — but the deep reference holds {deepMatches.length}.
              </div>
              <DeepSection entries={deepMatches} />
            </>
          ) : (
            <>
              <button type="button" className="gloss-deep-toggle" onClick={() => setDeepOpen(!deepOpen)}>
                <span className="gloss-deep-toggle-label">
                  {deepOpen ? '▾ HIDE DEEP REFERENCE' : '▸ SHOW DEEP REFERENCE — THE FULL LEDGER'}
                </span>
                <span className="gloss-deep-toggle-count">{deep ? `${deep.length} entries` : '500+ entries'}</span>
              </button>
              {deepOpen ? deepRows === null ? <Loading /> : <DeepSection entries={deepRows} /> : null}
            </>
          )}
        </div>
        <div className="gloss-scrub" aria-label="Jump to letter">
          {LETTERS.map((l) => (
            <button
              key={l}
              type="button"
              className="gloss-scrub-letter"
              disabled={!present.has(l)}
              onClick={() => jumpTo(l)}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <Attribution full />
    </div>
  );
}

/** Deep-reference rows: muted, DEEP CUT badge, one-liner, Wikipedia link out. */
function DeepSection({ entries }: { entries: DeepEntry[] }) {
  return (
    <div className="gloss-deep">
      <div className="gloss-deep-head">
        <span className="gloss-deep-head-label">DEEP REFERENCE</span>
        <span className="gloss-deep-head-rule" />
      </div>
      {entries.length === 0 ? <div className="empty-note">No deep entries match.</div> : null}
      {entries.map((e) => (
        <div key={`${e.term}#${e.anchor}`} className="gloss-deep-row">
          <div className="gloss-row-head">
            <span className="gloss-deep-term">
              <SuitText text={e.term} />
            </span>
            <span className="gloss-deepcut">DEEP CUT</span>
          </div>
          <div className="gloss-deep-def">
            <SuitText text={e.def} />{' '}
            <a className="gloss-deep-link" href={deepEntryUrl(e)} target="_blank" rel="noopener noreferrer">
              Read on Wikipedia ↗
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}
