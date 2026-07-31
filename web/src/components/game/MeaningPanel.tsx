import type { BidMeaning } from '../../api';
import { Chip } from '../ds/Chip';
import { CallText } from './CallText';
import { GlossaryProse } from './GlossaryProse';

/** Forcing qualifier chip: same typography as the other chips, red for game-forcing. */
export function ForcingChip({ forcing }: { forcing?: BidMeaning['forcing'] }) {
  if (!forcing) return null;
  return forcing === 'game' ? <Chip className="chip-gf">Game forcing</Chip> : <Chip>Forcing</Chip>;
}

/**
 * The SAYC meaning panel (perforated). Five content states:
 * placeholder (nothing selected), full meaning, meaning without the exact
 * flag (caveat line), the no-convention fallback, and sealed (own-side
 * meanings hidden — see `hidden` below).
 *
 * This is the live "Your" preview in BidBox, always the human's own South
 * call during bidding — there is no seat check here (unlike AuctionGrid/
 * CallInspector, which inspect PAST calls from any seat): bidding never
 * flips, so a caller just passes `ownMeaningsHidden` straight through as
 * `hidden`.
 */
export function MeaningPanel({
  meaning,
  call,
  prefix,
  placeholder = false,
  hidden = false,
}: {
  meaning?: BidMeaning | null;
  call?: number;
  prefix?: string;
  placeholder?: boolean;
  hidden?: boolean;
}) {
  if (placeholder) {
    return (
      <div className="meaning-panel meaning-panel-placeholder">
        {hidden ? 'Tap a bid, then tap again to make the call.' : 'Tap a bid to see what it means, then tap again to make the call.'}
      </div>
    );
  }
  if (hidden) {
    return (
      <div className="meaning-panel meaning-sealed">
        <div className="mtitle">
          {prefix} {call !== undefined ? <CallText call={call} /> : null}
        </div>
        Sealed — turn off &ldquo;Hide your side&rsquo;s bid meanings&rdquo; in Settings to see it.
      </div>
    );
  }
  if (!meaning) {
    return (
      <div className="meaning-panel">
        <div className="mtitle">{call !== undefined ? <CallText call={call} /> : null}</div>
        No standard SAYC meaning in this sequence — use your judgment.
      </div>
    );
  }
  return (
    <div className="meaning-panel">
      <div className="mtitle">
        {prefix} {call !== undefined ? <CallText call={call} /> : null} — <GlossaryProse text={meaning.title} />
      </div>
      {meaning.points || meaning.shapePromise || meaning.forcing ? (
        <div className="meaning-chips">
          {meaning.points ? <Chip>{meaning.points}</Chip> : null}
          {meaning.shapePromise ? (
            <Chip quiet>
              <GlossaryProse text={meaning.shapePromise} />
            </Chip>
          ) : null}
          <ForcingChip forcing={meaning.forcing} />
        </div>
      ) : null}
      <div className="meaning-body">
        <GlossaryProse text={meaning.description} />
      </div>
      {!meaning.exact ? <div className="meaning-caveat">Beyond the SAYC pamphlet — general guidance only.</div> : null}
    </div>
  );
}
