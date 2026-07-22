import { Link } from 'react-router-dom';

export type TabName = 'CROSSINGS' | 'STATS' | 'RANKINGS';

/**
 * Bottom tabs — Besley caps, inset 3px ink top bar marks the active tab.
 * Active is decided per-tab, by comparing `pathname` against that tab's own
 * link — not by which route "family" the page belongs to — so STATS only
 * lights up on your own profile (/players/:myId), never someone else's.
 */
export function TabBar({ myId, pathname }: { myId: number; pathname: string }) {
  const tabs: { name: TabName; to: string }[] = [
    { name: 'CROSSINGS', to: '/' },
    { name: 'STATS', to: `/players/${myId}` },
    { name: 'RANKINGS', to: '/leaderboard' },
  ];
  return (
    <nav className="tabbar">
      {tabs.map((t) => {
        const active = pathname === t.to;
        return (
          <Link key={t.name} to={t.to} className={active ? 'tab-active' : ''} aria-current={active ? 'page' : undefined}>
            {t.name}
          </Link>
        );
      })}
    </nav>
  );
}
