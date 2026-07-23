import { createContext, useContext, useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Me, api } from './api';
import { Splash } from './components/Splash';
import { Loading } from './components/ds/Loading';
import { TabBar } from './components/ds/TabBar';
import { GlossaryProvider } from './glossary/GlossaryContext';
import Board from './pages/Board';
import CreateHandle from './pages/CreateHandle';
import Glossary from './pages/Glossary';
import Leaderboard from './pages/Leaderboard';
import Lobby from './pages/Lobby';
import Login from './pages/Login';
import NotFound from './pages/NotFound';
import Player from './pages/Player';
import Scenarios from './pages/Scenarios';
import Tournament from './pages/Tournament';
import { splashOnReturn, stampVisit } from './splash';
import { applyThemePref, readThemePref } from './theme';

export const MeContext = createContext<{ me: Me | null; refresh: () => void }>({ me: null, refresh: () => {} });
export const useMe = () => useContext(MeContext);

/**
 * Bottom tabs appear on the top-level screens only — including
 * someone else's profile, reachable from the leaderboard or a tournament's
 * field standings, since it's still useful chrome to jump back out from
 * there — while tournament and board flows use their own headers. Which tab
 * (if any) reads as *active* is a separate question TabBar answers itself,
 * by comparing the current path against each tab's own link: the STATS tab
 * always links to /players/:myId, so it only lights up on your own profile,
 * not anyone else's — tapping it there is a real navigation, not a no-op,
 * so it shouldn't claim "you are here".
 */
function inTabScope(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/leaderboard' ||
    pathname.startsWith('/players/') ||
    pathname === '/glossary' ||
    pathname.startsWith('/glossary/')
  );
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

  const showTabs = Boolean(me?.user) && inTabScope(pathname);

  return (
    <MeContext.Provider value={{ me, refresh }}>
      <div className="shell">
        {me?.user && !me.user.handle ? (
          <CreateHandle />
        ) : me?.user ? (
          <GlossaryProvider>
            <Routes>
              <Route path="/" element={<Lobby />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/players/:id" element={<Player />} />
              <Route path="/glossary" element={<Glossary />} />
              <Route path="/glossary/:slug" element={<Glossary />} />
              <Route path="/t/:tid" element={<Tournament />} />
              <Route path="/t/:tid/review" element={<Tournament />} />
              <Route path="/t/:tid/b/:no" element={<Board />} />
              <Route path="/scenarios" element={<Scenarios />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
            {showTabs ? <TabBar myId={me.user.id} pathname={pathname} /> : null}
            {splash ? <Splash onDone={() => setSplash(false)} /> : null}
          </GlossaryProvider>
        ) : (
          <Login />
        )}
      </div>
    </MeContext.Provider>
  );
}
