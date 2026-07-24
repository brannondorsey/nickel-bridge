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

/** Client-only exhibits: the entry screens, shown as overlays on demand. */
const FRONT_DOOR: { key: Overlay; label: string; description: string }[] = [
  {
    key: 'splash',
    label: 'The returning-visitor curtain',
    description: 'The splash that greets players back after three days away. Plays once and lifts on its own — tap anywhere to skip.',
  },
  {
    key: 'login',
    label: 'The logged-out landing',
    description:
      'The splash with the toll gate closed. Its buttons are live — a dev sign-in really signs you in as someone new; follow the /demo link again to come back as the Inspector.',
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
                  The new-player tour: meet the tollkeeper, walk practice board №0 through the real Board UI, and
                  read the ledger. Demo mode never forces it — it only lives here. Skip or finish to come back.
                </span>
              </div>
              <Button variant="secondary" onClick={() => navigate('/tour')}>
                ENTER →
              </Button>
            </div>
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
