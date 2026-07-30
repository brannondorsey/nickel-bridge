import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

export type TabName = 'TOURNEYS' | 'STATS' | 'RANKINGS' | 'TRAFFIC' | 'GLOSSARY' | 'SETTINGS';

/**
 * Bottom tabs — Besley caps, inset 3px ink top bar marks the active tab.
 * The bar is a "turnstile" (approved nav pattern 1g), but a latent one: tabs
 * grow to share the full width and only overflow into a horizontal scroll —
 * with a paper fade + chevron on whichever edge still has tabs past it, and
 * active-tab auto-centering — when their labels genuinely can't fit. Five
 * gates is where that starts to bite at phone width, and SETTINGS (the sixth)
 * puts the row properly past it: the bar scrolls on every phone now, which is
 * what the pattern was built for. The answer is still the scroll working
 * properly, not a hamburger.
 *
 * The tab padding is deliberately generous enough that when the row does
 * overflow it overflows OBVIOUSLY. Five gates at the old padding cleared the
 * viewport by about fifteen pixels on a common phone, which reads as a
 * mis-rendered label rather than as something you can drag.
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
    { name: 'TRAFFIC', to: '/activity', active: pathname === '/activity' },
    { name: 'GLOSSARY', to: '/glossary', active: pathname === '/glossary' || pathname.startsWith('/glossary/') },
    { name: 'SETTINGS', to: '/settings', active: pathname === '/settings' },
  ];

  // A fade belongs on an edge only when there is actually something past it.
  // Measured on scroll as well as resize: the bar auto-centers the active tab
  // below, so it very often opens already pinned to one end — and a chevron
  // pointing at nothing, over a tab that is fully scrolled into view, reads as
  // a permanently clipped label rather than as an invitation to scroll.
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      // A pixel of slack, because fractional layout widths mean scrollLeft
      // rarely lands exactly on 0 or on max.
      setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [pathname]);

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
      {edges.left ? (
        <div className="tabbar-fade tabbar-fade-left" aria-hidden="true">
          ‹
        </div>
      ) : null}
      {edges.right ? (
        <div className="tabbar-fade" aria-hidden="true">
          ›
        </div>
      ) : null}
    </nav>
  );
}
