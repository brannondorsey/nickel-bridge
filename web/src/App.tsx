import { createContext, useContext, useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { Me, api } from './api';
import Board from './pages/Board';
import Leaderboard from './pages/Leaderboard';
import Lobby from './pages/Lobby';
import Login from './pages/Login';
import Tournament from './pages/Tournament';

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
        {me?.user ? (
          <>
            <header className="topbar">
              <Link to="/" className="brand">
                Bridge<span>Bot</span>
              </Link>
              <nav>
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
