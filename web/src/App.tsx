import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Me, api } from './api';
import { Splash } from './components/Splash';
import { Loading } from './components/ds/Loading';
import { SignInBar } from './components/ds/SignInBar';
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
import Tour from './pages/Tour';
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
    isGlossaryPath(pathname)
  );
}

/**
 * The glossary is the one part of the app that reads without an account.
 *
 * It's static reference data (web/src/glossary/) with no board state, no
 * standings and nothing user-scoped, so there is nothing to gate — and it is
 * the app's front door from search: ~900 bridge terms, each a page someone
 * might land on from a query like "what is a squeeze in bridge". Requiring a
 * sign-in to read them means search engines see a login screen and index
 * nothing, which is why these two routes sit outside the auth branch below.
 * The build also prerenders them to static HTML for crawlers that don't run JS
 * (web/scripts/prerender-glossary.mjs); this gate is what makes those pages honest
 * when a real visitor follows one in.
 */
function isGlossaryPath(pathname: string): boolean {
  return pathname === '/glossary' || pathname.startsWith('/glossary/');
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
  // record stays correct if the same origin ever leaves demo mode. A
  // not-yet-onboarded user gets the first-crossing tour instead of the
  // splash (it IS their first-visit moment); the visit still stamps, so no
  // splash replays right after the tour either.
  const authed = Boolean(me?.user?.handle);
  const demo = Boolean(me?.demo);
  const onboarded = me?.user?.onboardedAt != null;
  // The automatic tour fires only on ARRIVAL at the main app: someone opening
  // a shared deep link (a tournament, a profile) goes straight to it, and
  // meets the tour whenever they next open the app at home instead. Captured
  // once at mount — navigating home mid-session must never spring a tutorial.
  const [tourOnArrival] = useState(pathname === '/');
  useEffect(() => {
    if (!authed) return;
    if (!demo && onboarded && splashOnReturn()) setSplash(true);
    stampVisit();
  }, [authed, demo, onboarded]);

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
        ) : me?.user && !onboarded && !demo && tourOnArrival ? (
          // First crossing: new accounts arriving at the main app meet the
          // toll office before it (deep-link arrivals skip straight to their
          // destination — see tourOnArrival above). Demo mode suppresses it
          // for the shared Inspector the same way it suppresses the splash;
          // it stays replayable at /tour (Glossary's APP TOUR row, demo's
          // gallery row).
          //
          // Its own provider: the tour renders in place of the routes, but its
          // narration links terms like anything else, and a term sheet is the
          // one thing a first-timer needs most. The sheet lives in the URL as
          // ?term=, which leaves the path alone — so opening one never trips
          // the arrival gate or unmounts the tour mid-deal.
          <GlossaryProvider>
            <Tour />
          </GlossaryProvider>
        ) : me?.user ? (
          <GlossaryProvider>
            <Routes>
              <Route path="/" element={<Lobby />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/players/:id" element={<Player />} />
              <Route path="/glossary" element={<Glossary />} />
              <Route path="/glossary/:slug" element={<Glossary />} />
              <Route path="/t/:tid" element={<Tournament />} />
              <Route path="/t/:tid/review" element={<TournamentReviewRedirect />} />
              <Route path="/t/:tid/b/:no" element={<Board />} />
              <Route path="/tour" element={<Tour />} />
              <Route path="/scenarios" element={<Scenarios />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
            {showTabs ? <TabBar myId={me.user.id} pathname={pathname} /> : null}
            {splash ? <Splash onDone={() => setSplash(false)} /> : null}
          </GlossaryProvider>
        ) : isGlossaryPath(pathname) ? (
          // Signed out, but on a public route: render the glossary itself
          // rather than the login splash (see isGlossaryPath). Its own
          // provider, for the same reason the tour needs one — this branch
          // renders in place of the authed <Routes>, which is what the
          // app-wide provider wraps. SignInBar takes the TabBar's slot, since
          // every tab but this one leads somewhere that needs an account.
          <GlossaryProvider>
            <Routes>
              <Route path="/glossary" element={<Glossary />} />
              <Route path="/glossary/:slug" element={<Glossary />} />
            </Routes>
            <SignInBar />
          </GlossaryProvider>
        ) : (
          <Login />
        )}
      </div>
    </MeContext.Provider>
  );
}

/**
 * /t/:tid/review used to be the second face of a finished tournament — the
 * board sheet you toggled to from the postmarked result. The result page now
 * carries its own tappable board-by-board ledger, so the route survives only
 * to forward anything still pointing at it (bookmarks, an old back-stack
 * entry) onto the one page that shows all of it.
 */
function TournamentReviewRedirect() {
  const { tid } = useParams();
  return <Navigate to={`/t/${tid}`} replace />;
}
