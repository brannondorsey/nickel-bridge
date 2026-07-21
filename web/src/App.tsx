import { createContext, useContext, useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Me, api } from './api';
import { Splash } from './components/Splash';
import { Loading } from './components/ds/Loading';
import { TabBar, type TabName } from './components/ds/TabBar';
import Board from './pages/Board';
import CreateHandle from './pages/CreateHandle';
import Leaderboard from './pages/Leaderboard';
import Lobby from './pages/Lobby';
import Login from './pages/Login';
import Player from './pages/Player';
import Scenarios from './pages/Scenarios';
import Tournament from './pages/Tournament';
import { splashOnReturn, stampVisit } from './splash';
import { applyThemePref, readThemePref } from './theme';

export const MeContext = createContext<{ me: Me | null; refresh: () => void }>({ me: null, refresh: () => {} });
export const useMe = () => useContext(MeContext);

/** Bottom tabs appear on the three top-level screens only; tournament and board flows use their own headers. */
function activeTab(pathname: string): TabName | null {
  if (pathname === '/') return 'CROSSINGS';
  if (pathname === '/leaderboard') return 'RANKINGS';
  if (pathname.startsWith('/players/')) return 'STATS';
  return null;
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [splash, setSplash] = useState(false);
  const { pathname } = useLocation();

  const refresh = () => {
    api
      .me()
      .then(setMe)
      .finally(() => setLoaded(true));
  };
  useEffect(refresh, []);

  // The blocking inline script in index.html already set data-theme/theme-color
  // before first paint; this only keeps <meta name="theme-color"> live for a
  // 'system' visitor whose OS scheme flips while the tab stays open — the CSS
  // media query already repaints on its own, no JS needed for that part.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (readThemePref() === 'system') applyThemePref('system');
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // 'adaptive' has no media query to repaint it for free — re-apply on a timer so a
  // visitor who leaves the tab open across the 9 PM/7 AM boundary still flips live.
  useEffect(() => {
    const id = setInterval(() => {
      if (readThemePref() === 'adaptive') applyThemePref('adaptive');
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // Returning-visitor gate: decide from the previous stamp BEFORE writing
  // today's, or the splash would never show again. Demo mode (PR previews)
  // suppresses the splash itself — testers only see it by opening its
  // exhibit on the /scenarios gallery — but still stamps the visit, so the
  // record stays correct if the same origin ever leaves demo mode.
  const authed = Boolean(me?.user?.handle);
  const demo = Boolean(me?.demo);
  useEffect(() => {
    if (!authed) return;
    if (!demo && splashOnReturn()) setSplash(true);
    stampVisit();
  }, [authed, demo]);

  if (!loaded) {
    return (
      <div className="shell">
        <Loading />
      </div>
    );
  }

  const tab = me?.user ? activeTab(pathname) : null;

  return (
    <MeContext.Provider value={{ me, refresh }}>
      <div className="shell">
        {me?.user && !me.user.handle ? (
          <CreateHandle />
        ) : me?.user ? (
          <>
            <Routes>
              <Route path="/" element={<Lobby />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/players/:id" element={<Player />} />
              <Route path="/t/:tid" element={<Tournament />} />
              <Route path="/t/:tid/b/:no" element={<Board />} />
              <Route path="/scenarios" element={<Scenarios />} />
            </Routes>
            {tab ? <TabBar myId={me.user.id} active={tab} /> : null}
            {splash ? <Splash onDone={() => setSplash(false)} /> : null}
          </>
        ) : (
          <Login />
        )}
      </div>
    </MeContext.Provider>
  );
}
