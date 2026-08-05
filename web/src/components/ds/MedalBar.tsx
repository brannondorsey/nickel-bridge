import { Link } from 'react-router-dom';
import { MedalProgress, MedalSuit } from '../../api';
import { MedalGlyphs } from './MedalGlyphs';

const TIER_GLYPH: Record<MedalSuit, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };
const TIER_CLASS: Record<MedalSuit, string> = { c: 'suit-c', d: 'suit-d', h: 'suit-h', s: 'suit-s' };

/** Mirrors packages/core/src/medals.ts's MEDAL_TIERS[0].threshold — the club tier is earned at 4 tournaments. */
const CLUB_MEDAL_THRESHOLD = 4;

const tournamentWord = (n: number) => (n === 1 ? 'tournament' : 'tournaments');

function Sentence({ progress, provisionalMin }: { progress: MedalProgress; provisionalMin: number }) {
  const { target, tournamentsRemaining } = progress;
  if (!target) {
    return <p className="medal-cta">Every medal earned — every crossing from here is for its own sake.</p>;
  }
  // The club tier's copy names an app mechanic rather than itself: on a
  // deployment where the leaderboard's rated-tournament quota
  // (`provisionalMin`, server/src/tournaments.ts's provisionalMin()) is also
  // 4, "join the rankings" is literally true, not just flavor — "rankings"
  // links straight there, a solid underline (.medal-link) rather than
  // GlossaryProse's dotted one, since this is a real navigation, not a term
  // sheet. DEMO=1 relaxes that quota to 1, so by the time a demo player
  // reaches the club medal they've already joined the rankings — the
  // sentence falls back to the ordinary glyph phrasing there instead of
  // repeating a claim that's already false. The other tiers always name the
  // glyph — it's already colored in the cluster beside this sentence and in
  // the sentence itself, so spelling out "Diamond"/"Heart"/"Spade" would
  // only repeat what the mark already says.
  const goal =
    target === 'c' && provisionalMin === CLUB_MEDAL_THRESHOLD ? (
      <>
        join the{' '}
        <Link to="/leaderboard" className="medal-link">
          rankings
        </Link>
      </>
    ) : (
      <>
        earn the <span className={TIER_CLASS[target]}>{TIER_GLYPH[target]}</span> medal
      </>
    );
  return (
    <p className="medal-cta">
      Complete <b>{tournamentsRemaining}</b> more {tournamentWord(tournamentsRemaining)} to {goal}.
    </p>
  );
}

/**
 * Home's medal rail — the whole widget in two rows: a bar, then the four
 * suit marks close together with the sentence running beside them on the
 * same line. Fed by one server-computed `MedalProgress` (server/src/medals.ts,
 * `/api/me`'s `medals` field) so this component only renders, never computes.
 *
 * The bar's track is outlined, matching `TrickArea.tsx`'s trick-meter — the
 * bar in the middle of the card-play screen — rather than the borderless
 * `PctBar` used elsewhere; unlike the trick-meter, the unfilled portion is a
 * flat `--chart-track` fill (no hatch), the same "nothing here yet"
 * convention `PctBar` itself uses. The fill's growing edge is capped with a
 * solid `1px` ink line too (`.medal-bar-fill.capped`), the same convention
 * trick-meter uses to keep its own fill's leading edge crisp against the
 * track rather than just fading into the color change — gated on `fillPct >
 * 0` so a fresh 0% bar shows no stray line at the left edge, mirroring
 * trick-meter's own `tricks > 0` gate on its `capped` class. See the
 * `.medal-bar-*` rules in style.css, placed beside `.trick-meter-*`.
 */
export function MedalBar({
  progress,
  provisionalMin,
}: {
  progress: MedalProgress;
  /** server/src/tournaments.ts's provisionalMin() — see Sentence's doc comment. Defaults to the production quota. */
  provisionalMin?: number;
}) {
  const { earned, target, pct } = progress;
  const fillPct = target ? pct : 100;
  return (
    <div className="medal-bar">
      <div className="medal-bar-line">
        <div className="medal-bar-track">
          <div
            className={`medal-bar-fill tint-${target ?? 's'}${fillPct > 0 ? ' capped' : ''}`}
            style={{ width: `${fillPct}%` }}
          />
        </div>
        <span className="medal-pct num">{fillPct}%</span>
      </div>
      <div className="medal-row">
        <MedalGlyphs earned={earned} mode="all" />
        <div className="medal-text">
          <Sentence progress={progress} provisionalMin={provisionalMin ?? CLUB_MEDAL_THRESHOLD} />
        </div>
      </div>
    </div>
  );
}
