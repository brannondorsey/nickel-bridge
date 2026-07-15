import { Link } from 'react-router-dom';

export type TabName = 'CROSSINGS' | 'STATS' | 'RANKINGS';

/** Bottom tabs — Besley caps, inset 3px ink top bar marks the active tab. */
export function TabBar({ myId, active }: { myId: number; active: TabName }) {
  const tabs: { name: TabName; to: string }[] = [
    { name: 'CROSSINGS', to: '/' },
    { name: 'STATS', to: `/players/${myId}` },
    { name: 'RANKINGS', to: '/leaderboard' },
  ];
  return (
    <nav className="tabbar">
      {tabs.map((t) => (
        <Link key={t.name} to={t.to} className={t.name === active ? 'tab-active' : ''} aria-current={t.name === active ? 'page' : undefined}>
          {t.name}
        </Link>
      ))}
    </nav>
  );
}
