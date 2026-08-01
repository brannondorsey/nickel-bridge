import { useMemo, useState } from 'react';
import { bidLevel, callDisplay, isBid, makeBid } from '../../api';
import { CallText } from './CallText';

/** how many level rows the box shows before folding the rest away */
const VISIBLE_LEVELS = 4;

/**
 * The 38-call bid box, shown as a sliding window of VISIBLE_LEVELS level rows.
 *
 * Legality on the ladder is monotonic — once the auction reaches 4♠ nothing at
 * or below it can ever be legal again — so levels under the current contract
 * are dead weight, not "maybe later" targets. The window therefore STARTS at
 * the level holding the lowest legal bid and is never expandable downward:
 * there is nothing to reveal. Levels above the window sit behind the in-place
 * fold, so unless the reader opens it the box is at most VISIBLE_LEVELS rows
 * tall and gets SHORTER as the auction climbs, which is the whole point — the
 * docked box (.bidding-dock) eats the auction's scroll region, and a slam
 * auction used to render all seven rows with 20+ of them greyed out, pushing
 * the auction off screen.
 *
 * Every tap just calls onSelect; the parent decides select-vs-commit, so a
 * second tap on the already-selected call bids it (tap-to-bid, mirroring card
 * play) while the confirm CTA remains an equal path. Class names
 * .bidbox/.bid/.callrow/.confirm-row are selected on by the e2e smoke test.
 */
export function BidBox({
  legalCalls,
  selected,
  onSelect,
  onConfirm,
  busy,
  hint = null,
}: {
  legalCalls: number[];
  selected: number | null;
  onSelect: (call: number) => void;
  onConfirm: () => void;
  busy: boolean;
  /** first-crossing tour: pulse this call as the tollkeeper's suggestion */
  hint?: number | null;
}) {
  const legal = useMemo(() => new Set(legalCalls), [legalCalls]);
  // Where the window starts: the level of the cheapest still-legal bid. The one
  // auction with no leveled bid legal at all is 7NT, the TOP of the ladder — so
  // it falls back to 7, one spent row, rather than an empty box (nothing to
  // show) or level 1 (twenty dead buttons and a fold promising fifteen more).
  const firstLevel = useMemo(() => {
    const bids = legalCalls.filter(isBid);
    return bids.length > 0 ? bidLevel(Math.min(...bids)) : 7;
  }, [legalCalls]);
  // The fold is a per-decision affordance — someone reaching for a slam this
  // turn hasn't asked to be shown levels 5-7 for the rest of the auction. So we
  // remember the window it was opened on, and the expansion LAPSES when the
  // auction climbs past it. Left sticky, one tap during a preempt would undo
  // the windowing for every later turn, which is the bug this box exists to
  // fix; BidBox stays mounted between the human's turns (Board.tsx swaps in
  // "Robots are thinking…" only when the response says it's not our turn, and
  // mid-auction it never does), so nothing else would ever reset it.
  const [expandedAt, setExpandedAt] = useState<number | null>(null);
  const expanded = expandedAt === firstLevel;
  const lastLevel = expanded ? 7 : Math.min(7, firstLevel + VISIBLE_LEVELS - 1);

  // While a call is in flight (busy) every button locks: a click landing on a
  // stale still-enabled button could toggle the selection off mid-submit and
  // leave the confirm CTA dead until the user reselects.
  const bidButton = (call: number) => (
    <button
      key={call}
      type="button"
      className={`bid${selected === call ? ' selected' : ''}${hint === call && selected !== call ? ' bid-hint' : ''}`}
      disabled={busy || !legal.has(call)}
      onClick={() => onSelect(call)}
      aria-label={callDisplay(call)}
    >
      <CallText call={call} />
    </button>
  );

  return (
    <div className="bidbox-wrap">
      <div className="bidbox">
        {Array.from({ length: lastLevel - firstLevel + 1 }, (_, i) => firstLevel + i).map((level) => (
          <div className="grid" key={level}>
            {Array.from({ length: 5 }, (_, strain) => makeBid(level, strain)).map(bidButton)}
          </div>
        ))}
        {lastLevel < 7 && (
          <button type="button" className="bidbox-fold" onClick={() => setExpandedAt(firstLevel)}>
            ▾ {lastLevel === 6 ? 'level 7' : `levels ${lastLevel + 1}–7`} below the fold ▾
          </button>
        )}
        <div className="callrow">
          {[0, 1, 2].map((call) => (
            <button
              key={call}
              type="button"
              className={`bid${selected === call ? ' selected' : ''}${call === 1 ? ' bid-x' : ''}`}
              disabled={busy || !legal.has(call)}
              onClick={() => onSelect(call)}
            >
              {callDisplay(call)}
            </button>
          ))}
        </div>
      </div>
      <div className="confirm-row">
        <button
          type="button"
          className="ds-btn btn-primary"
          disabled={selected === null || busy}
          onClick={onConfirm}
          aria-label={selected !== null ? `Bid ${callDisplay(selected)}` : 'Select a bid'}
        >
          {busy ? (
            '…'
          ) : selected !== null ? (
            <>
              BID <CallText call={selected} /> →
            </>
          ) : (
            'SELECT A BID'
          )}
        </button>
      </div>
    </div>
  );
}
