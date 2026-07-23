import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

export type TabName = 'TOURNEYS' | 'STATS' | 'RANKINGS' | 'GLOSSARY';

/**
 * Bottom tabs — Besley caps, inset 3px ink top bar marks the active tab.
 * The bar is a "turnstile" (approved nav pattern 1g), but a latent one: tabs
 * grow to share the full width and only overflow into a horizontal scroll —
 * with the right-edge paper fade + chevron and active-tab auto-centering —
 * when their labels genuinely can't fit. Today's four gates fit at phone
 * width; Learn/Clubs later will engage the scroll without a hamburger.
 *
 * Active is decided per-tab, by comparing `pathname` against that tab's own
 * link — not by which route "family" the page belongs to — so STATS only
 * lights up on your own profile (/players/:myId), never someone else's.
 * GLOSSARY is the one prefix match: /glossary/:slug deep links are still the
 * glossary screen (the slug only seeds the term sheet).
 */
export function TabBar({ myId, pathname }: { myId: number; pathname: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabs: { name: TabName; to: string; active: boolean }[] = [
    { name: 'TOURNEYS', to: '/', active: pathname === '/' },
    { name: 'STATS', to: `/players/${myId}`, active: pathname === `/players/${myId}` },
    { name: 'RANKINGS', to: '/leaderboard', active: pathname === '/leaderboard' },
    { name: 'GLOSSARY', to: '/glossary', active: pathname === '/glossary' || pathname.startsWith('/glossary/') },
  ];

  // The fade/chevron only makes sense when the row actually overflows —
  // at the full 430px shell width today's four tabs fit without scrolling.
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const measure = () => {
      const el = scrollRef.current;
      setOverflows(el ? el.scrollWidth > el.clientWidth : false);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Center the active tab whenever navigation moves it. jsdom has no
  // scrollIntoView, hence the feature guard.
  useEffect(() => {
    const active = scrollRef.current?.querySelector('[aria-current="page"]');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
  }, [pathname]);

  return (
    <nav className="tabbar">
      <div className="tabbar-scroll" ref={scrollRef}>
        {tabs.map((t) => (
          <Link key={t.name} to={t.to} className={t.active ? 'tab-active' : ''} aria-current={t.active ? 'page' : undefined}>
            {t.name}
          </Link>
        ))}
      </div>
      {overflows ? (
        <div className="tabbar-fade" aria-hidden="true">
          ›
        </div>
      ) : null}
    </nav>
  );
}
