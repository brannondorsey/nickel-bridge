import { useEffect, type ReactNode } from 'react';

/**
 * The toll-gate splash — wordmark, "DUPLICATE · SAYC", and the river scene
 * rising from the bottom edge (keyframes ported from the prototype).
 *
 * Two modes:
 * - auto (`onDone` set): overlay for logged-in users returning after 3+ days.
 *   Plays the full sequence, exits on its own at 3.3s; any tap (or the
 *   screen-reader skip button) ends it immediately.
 * - login (`cta` set): the hero of the logged-out landing page. No timer — plus
 *   the one-line pitch below the actions, and `cue`, which the landing page
 *   uses to say that the pitch continues below the fold. That cue is the only
 *   reason anyone scrolls: the hero is a full 100dvh and otherwise looks
 *   exactly like the dead-end splash it used to be.
 */
export function Splash({
  onDone,
  cta,
  pitch,
  cue,
}: {
  onDone?: () => void;
  cta?: ReactNode;
  pitch?: string;
  cue?: ReactNode;
}) {
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
      {cue ?? null}
      <div className="splash-bridge">
        {/* The scene is a repeating BACKGROUND rather than an <img>, and that
            is what lets the bridge span any viewport with none of it missing:
            the drawing is a 160-unit arch pattern that meets itself exactly at
            its own edges, so repeat-x tiles it seamlessly, and sizing it
            `auto 100%` means the whole height — deck, arches, piers, water —
            is always on screen. As an <img> it could only be `cover`, which
            scales by WIDTH: at 1440 that magnified the drawing 2.25x inside a
            fixed-height band and cropped everything above the waterline, so
            the desktop hero showed a river and no bridge. The day/night pair
            swaps in style.css beside every other theme override (an SVG loaded
            as an image can't read the host page's custom properties, so the
            night recolor has to be its own file either way). */}
        <div className="splash-scene" aria-hidden="true" />
      </div>
    </div>
  );
}
