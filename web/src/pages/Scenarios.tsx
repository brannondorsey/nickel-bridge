import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMe } from '../App';
import { DemoScenario, api } from '../api';
import { Splash } from '../components/Splash';
import { AppHeader } from '../components/ds/AppHeader';
import { Button } from '../components/ds/Button';
import { Loading } from '../components/ds/Loading';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { SuitText } from '../components/game/SuitText';
import CreateHandle from './CreateHandle';
import Login from './Login';

/**
 * The Exhibit Hall — demo mode's gallery of prepared states (PR previews
 * only; the server flags demo mode on /api/me and 404s the API elsewhere).
 * Each exhibit replays a real deal through the real engine and drops the
 * tester one action short of the interesting moment; they take the last step
 * themselves through the ordinary Board UI and use browser back to return.
 */

/** The client-only overlay exhibit screens. */
type Overlay = 'splash' | 'login' | 'handle';

/**
 * The signed-out exhibits. Unlike everything else in the hall, these END the
 * Inspector session — the states they show only exist without one, and an
 * overlay can't fake that: the landing page's own links, the tour's ending
 * gate, the ladder's unlinked rows and a refused profile are all decided by
 * whether `me.user` is null for real.
 *
 * `to` is resolved at click time because one of them needs a seeded id (see
 * the `richProfileId` row below).
 */
const SIGNED_OUT: { key: string; label: string; description: string; to: (ids: { richProfileId: number | null }) => string | null }[] = [
  {
    key: 'anon-landing',
    label: 'The front door, as a stranger',
    description:
      'What someone who has never signed in actually lands on: the splash, the pitch below it, and the three doors that ask no toll. Every link here is live and anonymous.',
    to: () => '/',
  },
  {
    key: 'anon-tour',
    label: 'The practice deal, no account',
    description:
      'Board №0 walked with no session at all — the same real Board UI, but ending at the toll gate instead of a lobby. Walk it to the postmark to see the sign-in ask; sign in there and the tour will not be shown to you a second time.',
    to: () => '/tour',
  },
  {
    key: 'anon-rankings',
    label: 'The rankings, as a stranger',
    description:
      'The ladder reads without an account, but the players on it do not: the human rows are deliberately unlinked, and the house panel underneath is the one profile a stranger can open.',
    to: () => '/leaderboard',
  },
  {
    key: 'anon-profile-refused',
    label: 'A player’s record, refused',
    description:
      'A real (seeded) player’s stats page with no session — the explanation a stranger gets instead. The server’s refusal is deliberately identical for an id nobody has, so the page can’t claim “not found”.',
    to: (ids) => (ids.richProfileId != null ? `/players/${ids.richProfileId}` : null),
  },
];

/** Client-only exhibits: the entry screens, shown as overlays on demand. */
const FRONT_DOOR: { key: Overlay; label: string; description: string }[] = [
  {
    key: 'splash',
    label: 'The returning-visitor curtain',
    description: 'The splash that greets players back after three days away. Plays once and lifts on its own — tap anywhere to skip.',
  },
  {
    key: 'login',
    label: 'The landing page',
    description:
      'The whole front page — the splash, then the pitch under it and the three doors that need no account — shown over your Inspector session, so its own links still navigate the signed-in app. To use them as a stranger would, take the SIGNED OUT exhibits below. Its buttons are live: a dev sign-in really signs you in as someone new.',
  },
  {
    key: 'handle',
    label: 'Choose your handle',
    description:
      'The first-crossing handle prompt, prefilled with a name that’s already taken — submit it as-is and the live "handle already taken" error fires on the spot.',
  },
];

export default function Scenarios() {
  const { me, refresh } = useMe();
  const navigate = useNavigate();
  const demo = Boolean(me?.demo);
  const [scenarios, setScenarios] = useState<DemoScenario[] | null>(null);
  const [newCrosserId, setNewCrosserId] = useState<number | null>(null);
  const [richProfileId, setRichProfileId] = useState<number | null>(null);
  const [collisionHandle, setCollisionHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  useEffect(() => {
    if (!demo) return;
    api
      .demoScenarios()
      .then((r) => {
        setScenarios(r.scenarios);
        setNewCrosserId(r.newCrosserId ?? null);
        setRichProfileId(r.richProfileId ?? null);
        setCollisionHandle(r.collisionHandle ?? '');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load the exhibits'));
  }, [demo]);

  if (!demo) {
    return (
      <div className="exhibit">
        <AppHeader context="EXHIBIT HALL" />
        <div className="empty-note">
          The Exhibit Hall only opens on demo deployments. <Link to="/">Cross the bridge instead →</Link>
        </div>
      </div>
    );
  }

  const enter = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      const { tournamentId, boardNo } = await api.runDemoScenario(id);
      navigate(`/t/${tournamentId}/b/${boardNo}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to prepare the exhibit');
      setBusyId(null);
    }
  };

  /**
   * Leave as a stranger: drop the Inspector session, then load the target with
   * a real navigation rather than a router push. The hard load is the point —
   * it boots the app exactly as a first-time visitor's browser would, with no
   * stale `me` to flash the signed-in variant of the screen on the way. The
   * way back is /demo, which signs the Inspector in again (said once, on the
   * panel, rather than four times in the rows).
   */
  const leaveAnonymously = async (key: string, to: string) => {
    if (busyId) return;
    setBusyId(key);
    setError(null);
    try {
      await api.logout();
    } catch {
      /* already signed out, or the session was gone — either way, carry on */
    }
    window.location.assign(to);
  };

  const reset = async () => {
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    setResetBusy(true);
    setError(null);
    try {
      await api.resetDemo();
      setResetArmed(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'reset failed');
    } finally {
      setResetBusy(false);
    }
  };

  // Section order comes from the catalog itself (first appearance wins), so
  // a new category added in server/src/scenarios.ts renders with no frontend
  // change — a hardcoded list here would silently drop it.
  const categories = [...new Set((scenarios ?? []).map((s) => s.category))];

  return (
    <div className="exhibit">
      <AppHeader context="EXHIBIT HALL" />
      <div className="exhibit-head">
        <div className="label-caps">CURATED CROSSINGS</div>
        <h1 className="exhibit-title">The Exhibit Hall</h1>
        <p className="exhibit-hint">
          Every exhibit is a real deal played by the real engine — step in, take the last action yourself, and use
          your browser’s back button to return here. Re-entering an exhibit deals it fresh.
        </p>
      </div>

      {error ? <div className="notice-error">{error}</div> : null}

      {scenarios === null && !error ? (
        <Loading />
      ) : (
        <>
          {categories.map((cat) => (
            <PerforatedPanel key={cat} heading={cat.toUpperCase()} className="exhibit-panel">
              {scenarios!
                .filter((s) => s.category === cat)
                .map((s) => (
                  <div key={s.id} className="exhibit-row">
                    <div className="exhibit-row-text">
                      <b>
                        <SuitText text={s.label} />
                      </b>
                      <span className="exhibit-row-desc">
                        <SuitText text={s.description} />
                      </span>
                    </div>
                    <Button
                      variant="secondary"
                      onClick={() => enter(s.id)}
                      busy={busyId === s.id}
                      busyLabel="DEALING…"
                      disabled={busyId !== null && busyId !== s.id}
                    >
                      ENTER →
                    </Button>
                  </div>
                ))}
            </PerforatedPanel>
          ))}

          <PerforatedPanel heading="FRONT DOOR" className="exhibit-panel">
            {FRONT_DOOR.map((f) => (
              <div key={f.key} className="exhibit-row">
                <div className="exhibit-row-text">
                  <b>{f.label}</b>
                  <span className="exhibit-row-desc">{f.description}</span>
                </div>
                <Button variant="secondary" onClick={() => setOverlay(f.key)}>
                  ENTER →
                </Button>
              </div>
            ))}
            <div className="exhibit-row">
              <div className="exhibit-row-text">
                <b>The first crossing</b>
                <span className="exhibit-row-desc">
                  The new-player tour: practice board №0 walked through the real Board UI with the tollkeeper,
                  and the ledger at the end. Nothing precedes the deal — the landing page already made the pitch. Demo mode never forces it — it only lives
                  here. Skipping or finishing lands in the lobby; the row stays here to re-enter as often as you
                  like.
                </span>
              </div>
              <Button variant="secondary" onClick={() => navigate('/tour')}>
                ENTER →
              </Button>
            </div>
          </PerforatedPanel>

          <PerforatedPanel heading="SIGNED OUT" className="exhibit-panel">
            <p className="exhibit-panel-note">
              These sign you out for real — the states below only exist without a session. Open{' '}
              <b>/demo</b> to come back as the Inspector.
            </p>
            {SIGNED_OUT.map((s) => {
              const to = s.to({ richProfileId });
              return (
                <div key={s.key} className="exhibit-row">
                  <div className="exhibit-row-text">
                    <b>{s.label}</b>
                    <span className="exhibit-row-desc">{s.description}</span>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => to && leaveAnonymously(s.key, to)}
                    busy={busyId === s.key}
                    busyLabel="LEAVING…"
                    disabled={to === null || (busyId !== null && busyId !== s.key)}
                  >
                    ENTER →
                  </Button>
                </div>
              );
            })}
          </PerforatedPanel>

          <PerforatedPanel heading="PROFILES" className="exhibit-panel">
            <div className="exhibit-row">
              <div className="exhibit-row-text">
                <b>The field, ranked</b>
                <span className="exhibit-row-desc">The all-time Elo ladder, populated by the ambient field.</span>
              </div>
              <Button variant="secondary" onClick={() => navigate('/leaderboard')}>
                ENTER →
              </Button>
            </div>
            <div className="exhibit-row">
              <div className="exhibit-row-text">
                <b>The traffic, last seven days</b>
                <span className="exhibit-row-desc">
                  The activity feed: an hours rule per day with a mark for every run, and who crossed under it. The
                  ambient field is backdated across 35 days, so only the youngest tournaments land inside the
                  window — which makes this the exhibit for the empty-day treatment as much as the busy one. The
                  red rule on today marks the current minute.
                </span>
              </div>
              <Button variant="secondary" onClick={() => navigate('/activity')}>
                ENTER →
              </Button>
            </div>
            <div className="exhibit-row">
              <div className="exhibit-row-text">
                <b>A well-traveled stats page</b>
                <span className="exhibit-row-desc">
                  Rating trend, matchpoint history, bid-accuracy trend, and the percentile panel — all with real
                  numbers behind them.
                </span>
              </div>
              <Button
                variant="secondary"
                onClick={() => richProfileId != null && navigate(`/players/${richProfileId}`)}
                disabled={richProfileId == null}
              >
                ENTER →
              </Button>
            </div>
            <div className="exhibit-row">
              <div className="exhibit-row-text">
                <b>A stats page with nothing on it yet</b>
                <span className="exhibit-row-desc">
                  A permanent, never-played persona — the empty state a first-time player's own stats page shows
                  before their first crossing.
                </span>
              </div>
              <Button
                variant="secondary"
                onClick={() => newCrosserId != null && navigate(`/players/${newCrosserId}`)}
                disabled={newCrosserId == null}
              >
                ENTER →
              </Button>
            </div>
            {/* Compare's two states. Client-only rows rather than replay
                recipes: nothing here needs a scripted board, only two players
                with (and without) a shared history — and neither state is
                reachable by clicking around a fresh database, which is the
                rule that says an exhibit has to exist. */}
            <div className="exhibit-row">
              <div className="exhibit-row-text">
                <b>Compare, against someone you have met</b>
                <span className="exhibit-row-desc">
                  Your record beside a well-travelled bot's: the head-to-head slip, then the beam — bars that tip
                  toward whoever leads, with dashed gates marking the margin below which nothing is called. Grey
                  bars are the ones the ledger will not certify.
                </span>
              </div>
              <Button
                variant="secondary"
                onClick={() => richProfileId != null && navigate(`/compare/${richProfileId}`)}
                disabled={richProfileId == null}
              >
                ENTER →
              </Button>
            </div>
            <div className="exhibit-row">
              <div className="exhibit-row-text">
                <b>Compare, against a stranger</b>
                <span className="exhibit-row-desc">
                  The never-played persona, so there is no head-to-head to show. Common ground stands in — how each
                  of you has fared against the house, the one opponent you have both faced. Below the floor of 16
                  boards it becomes the "not enough crossings yet" state instead.
                </span>
              </div>
              <Button
                variant="secondary"
                onClick={() => newCrosserId != null && navigate(`/compare/${newCrosserId}`)}
                disabled={newCrosserId == null}
              >
                ENTER →
              </Button>
            </div>
          </PerforatedPanel>

          <PerforatedPanel heading="HOUSEKEEPING" dashed className="exhibit-panel">
            <div className="exhibit-row">
              <div className="exhibit-row-text">
                <b>Reset the exhibition</b>
                <span className="exhibit-row-desc">
                  Sweeps out every player, crossing, and score on this preview and lays the ambient data back down.
                  The seeding refills in the background over a minute or two; you stay signed in.
                </span>
              </div>
              <Button
                variant="secondary"
                onClick={reset}
                busy={resetBusy}
                busyLabel="SWEEPING…"
                className={resetArmed ? 'exhibit-reset-armed' : ''}
              >
                {resetArmed ? 'TAP AGAIN — SURE? →' : 'RESET →'}
              </Button>
            </div>
          </PerforatedPanel>

          <div className="exhibit-foot">
            Or <Link to="/">walk the bridge yourself →</Link>
          </div>
        </>
      )}

      {overlay ? (
        <div className="exhibit-overlay">
          {overlay === 'splash' ? (
            <Splash onDone={() => setOverlay(null)} />
          ) : (
            <>
              {overlay === 'login' ? <Login /> : <CreateHandle initialHandle={collisionHandle} />}
              <button type="button" className="exhibit-overlay-close label-caps" onClick={() => setOverlay(null)}>
                ✕ CLOSE EXHIBIT
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
