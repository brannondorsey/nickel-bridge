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
import { clearTourDone, peekTourDone } from './onboarding/tourDone';
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
 * nothing, which is why these two routes were the first to sit outside the
 * auth branch (isPublicPath below is now the gate for all of them).
 * The build also prerenders them to static HTML for crawlers that don't run JS
 * (web/scripts/prerender.mjs); this gate is what makes those pages honest
 * when a real visitor follows one in.
 */
function isGlossaryPath(pathname: string): boolean {
  return pathname === '/glossary' || pathname.startsWith('/glossary/');
}

/**
 * What the app shows to someone without an account.
 *
 * This used to be the glossary alone, on the narrow argument above. That
 * reasoning still holds for /glossary; the list is longer now for a different
 * one. A visitor was being asked to hand over a Google account before being
 * told what duplicate bridge is, or shown a single card — so the pitch (/),
 * the practice board (/tour, a captured replay with no server board behind
 * it) and the read-only record (/leaderboard, /players/:id) are all readable
 * first, and the toll is asked once, at a real tournament board.
 *
 * The honest version of the invariant, since "nothing user-scoped" no longer
 * covers profiles: nothing here WRITES, nothing here is scoped to the VIEWER,
 * and nothing here exposes live board state. A player's record is genuinely
 * someone's data — public by decision, and kept out of the search index by
 * robots.txt rather than by an auth wall (see server/src/app.ts).
 */
function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/tour' ||
    pathname === '/leaderboard' ||
    pathname.startsWith('/players/') ||
    isGlossaryPath(pathname)
  );
}

/**
 * Which public routes take the SignInBar in the TabBar's slot: the ones that
 * are just content. The landing page closes with its own sign-in actions and
 * the tour ends at the gate by design, so a bar on either would be the same
 * ask twice on one screen.
 */
function wantsSignInBar(pathname: string): boolean {
  return pathname !== '/' && pathname !== '/tour' && isPublicPath(pathname);
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

  // The public tour's claim: /tour reads without an account, so someone can
  // finish the whole practice board and only then sign in — arriving here as a
  // brand-new account, at '/', with onboarded_at NULL. That is exactly the
  // shape the arrival gate below fires on, so without this, finishing the tour
  // is rewarded with the tour.
  //
  // Three things about this one line of state (see onboarding/tourDone.ts):
  //
  // - Read at MOUNT, not in the effect. `me` resolves asynchronously, and the
  //   first render that has a user would otherwise flash the tour's welcome
  //   screen before any effect could suppress it.
  // - The read is NON-DESTRUCTIVE. StrictMode double-invokes this initializer
  //   in development, so a read-and-clear would spend the claim on the
  //   throwaway pass. Only the effect below clears, and only once it has
  //   something to trade it for.
  // - It is write-once for the session and never flipped back. It answers "has
  //   this person already walked the tour?", which never stops being true.
  //   Clearing it when the server stamp lands would re-open the gate for the
  //   render or two before the refreshed `me` arrives — and would show the
  //   tour outright if the stamp failed, which is the opposite of what
  //   someone who just finished it has earned.
  const [tourClaim] = useState(() => peekTourDone());
  useEffect(() => {
    // Keyed on the user id, not just on mount: Google sign-in is a full page
    // load so mount alone would do, but DEV_AUTH sign-in calls refresh() in
    // place and never remounts.
    if (!tourClaim || !me?.user) return; // nobody signed in yet — the claim keeps until it expires
    if (!peekTourDone()) return; // already spent, this session or another tab
    clearTourDone(); // spend it first, so it can't skip onboarding for whoever signs in here next
    if (onboarded) return; // an established account; nothing to trade it for
    api
      .setOnboarded()
      .catch(() => {
        /* the gate must never trap anyone; the suppression above stands regardless */
      })
      .finally(refresh);
  }, [tourClaim, me?.user?.id, onboarded]);

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
        ) : me?.user && !onboarded && !demo && tourOnArrival && !tourClaim ? (
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
        ) : (
          // Signed out. The public routes render themselves (see isPublicPath);
          // anything else — a shared board or tournament link, a typo — falls
          // through to the landing page, which is the invitation. Deliberately
          // not a 404: someone following a friend's link should be told how to
          // get in, not that the page doesn't exist.
          //
          // Its own GlossaryProvider, for the same reason the tour has one:
          // this branch renders in place of the authed <Routes>, which is what
          // the app-wide provider wraps. It has to cover the fallback too — the
          // landing page's prose links terms like every other teaching surface.
          <GlossaryProvider>
            <Routes>
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/players/:id" element={<Player />} />
              <Route path="/glossary" element={<Glossary />} />
              <Route path="/glossary/:slug" element={<Glossary />} />
              <Route path="/tour" element={<Tour />} />
              <Route path="*" element={<Login />} />
            </Routes>
            {wantsSignInBar(pathname) ? <SignInBar /> : null}
          </GlossaryProvider>
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
