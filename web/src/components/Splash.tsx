import { useEffect, type ReactNode } from 'react';
import riverScene from '../assets/bridge-river-scene.svg';

/**
 * The toll-gate splash — wordmark, "DUPLICATE · SAYC", and the river scene
 * rising from the bottom edge (keyframes ported from the prototype).
 *
 * Two modes:
 * - auto (`onDone` set): overlay for logged-in users returning after 3+ days.
 *   Plays the full sequence, exits on its own at 3.3s; any tap (or the
 *   screen-reader skip button) ends it immediately.
 * - login (`cta` set): the logged-out landing screen. No timer — the CTA is
 *   the only exit — plus the one-line pitch below the actions.
 */
export function Splash({ onDone, cta, pitch }: { onDone?: () => void; cta?: ReactNode; pitch?: string }) {
  useEffect(() => {
    if (!onDone) return;
    const t = setTimeout(onDone, 3300);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className={onDone ? 'splash splash-auto' : 'splash'} onClick={onDone} data-testid="splash">
      {onDone ? (
        <button type="button" className="sr-only" onClick={onDone}>
          Skip intro
        </button>
      ) : null}
      <div className="splash-stack">
        <div className="splash-word">NICKEL BRIDGE</div>
        <div className="splash-sub">DUPLICATE · SAYC</div>
        {cta ? <div className="splash-cta">{cta}</div> : null}
        {pitch ? <p className="splash-pitch">{pitch}</p> : null}
      </div>
      <div className="splash-bridge">
        <img src={riverScene} width="390" height="146" alt="" />
      </div>
    </div>
  );
}
