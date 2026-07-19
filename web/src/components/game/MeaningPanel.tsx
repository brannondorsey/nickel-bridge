import type { BidMeaning } from '../../api';
import { Chip } from '../ds/Chip';
import { CallText } from './CallText';
import { SuitText } from './SuitText';

/** Forcing qualifier chip: same typography as the other chips, red for game-forcing. */
export function ForcingChip({ forcing }: { forcing?: BidMeaning['forcing'] }) {
  if (!forcing) return null;
  return forcing === 'game' ? <Chip className="chip-gf">Game forcing</Chip> : <Chip>Forcing</Chip>;
}

/**
 * The SAYC meaning panel (perforated). Four content states:
 * placeholder (nothing selected), full meaning, meaning without the exact
 * flag (caveat line), and the no-convention fallback.
 */
export function MeaningPanel({
  meaning,
  call,
  prefix,
  placeholder = false,
}: {
  meaning?: BidMeaning | null;
  call?: number;
  prefix?: string;
  placeholder?: boolean;
}) {
  if (placeholder) {
    return (
      <div className="meaning-panel meaning-panel-placeholder">
        Tap a bid to see what it means, then tap again to make the call.
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
        {prefix} {call !== undefined ? <CallText call={call} /> : null} — <SuitText text={meaning.title} />
      </div>
      {meaning.points || meaning.shapePromise || meaning.forcing ? (
        <div className="meaning-chips">
          {meaning.points ? <Chip>{meaning.points}</Chip> : null}
          {meaning.shapePromise ? (
            <Chip quiet>
              <SuitText text={meaning.shapePromise} />
            </Chip>
          ) : null}
          <ForcingChip forcing={meaning.forcing} />
        </div>
      ) : null}
      <div className="meaning-body">
        <SuitText text={meaning.description} />
      </div>
      {!meaning.exact ? <div className="meaning-caveat">Beyond the SAYC pamphlet — general guidance only.</div> : null}
    </div>
  );
}
