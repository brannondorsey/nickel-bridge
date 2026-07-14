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
import Tournament from './pages/Tournament';
import { splashOnReturn, stampVisit } from './splash';

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

  // Returning-visitor gate: decide from the previous stamp BEFORE writing
  // today's, or the splash would never show again.
  const authed = Boolean(me?.user?.handle);
  useEffect(() => {
    if (!authed) return;
    if (splashOnReturn()) setSplash(true);
    stampVisit();
  }, [authed]);

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
