import { Suspense, createContext, lazy, useContext, useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { Me, api } from './api';
import Board from './pages/Board';
import CreateHandle from './pages/CreateHandle';
import Leaderboard from './pages/Leaderboard';
import Lobby from './pages/Lobby';
import Login from './pages/Login';
import Tournament from './pages/Tournament';

// stats pulls in the charting library — keep it out of the core game bundle
const Player = lazy(() => import('./pages/Player'));

const MeContext = createContext<{ me: Me | null; refresh: () => void }>({ me: null, refresh: () => {} });
export const useMe = () => useContext(MeContext);

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = () => {
    api
      .me()
      .then(setMe)
      .finally(() => setLoaded(true));
  };
  useEffect(refresh, []);

  if (!loaded) return <div className="spin" />;

  return (
    <MeContext.Provider value={{ me, refresh }}>
      <div className="shell">
        {me?.user && !me.user.handle ? (
          <CreateHandle />
        ) : me?.user ? (
          <>
            <header className="topbar">
              <Link to="/" className="brand">
                Nickel<span>Bridge</span>
              </Link>
              <nav>
                <Link to={`/players/${me.user.id}`}>My stats</Link>
                <Link to="/leaderboard">Rankings</Link>
                <button
                  onClick={async () => {
                    await api.logout();
                    refresh();
                  }}
                >
                  Sign out
                </button>
              </nav>
            </header>
            <Routes>
              <Route path="/" element={<Lobby />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route
                path="/players/:id"
                element={
                  <Suspense fallback={<div className="spin" />}>
                    <Player />
                  </Suspense>
                }
              />
              <Route path="/t/:tid" element={<Tournament />} />
              <Route path="/t/:tid/b/:no" element={<Board />} />
            </Routes>
          </>
        ) : (
          <Login />
        )}
      </div>
    </MeContext.Provider>
  );
}
