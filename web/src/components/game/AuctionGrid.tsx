import { useEffect, useRef } from 'react';
import type { AuctionEntry } from '../../api';
import { CallText } from './CallText';

/**
 * The double-bordered auction frame. Rows are packed N/E/S/W with the first
 * row front-padded so the dealer's call lands in its column. Calls with a
 * SAYC meaning get the dotted underline; every call is a button that opens
 * the inspector. Long auctions scroll inside the frame (sticky header,
 * autoscrolled to the newest row).
 */
export function AuctionGrid({
  auction,
  dealer,
  myTurn,
  live = false,
  onInspect,
  reserveThrough,
}: {
  auction: AuctionEntry[];
  dealer: number;
  myTurn: boolean;
  /**
   * The auction is still being made, so the newest call drops onto the tray
   * as it arrives (Board.tsx reveals a robot burst one call at a time — see
   * stageBidSteps). Off by default so a finished auction, shown beside the
   * play, doesn't animate its last call every time the board re-renders.
   */
  live?: boolean;
  onInspect: (entry: AuctionEntry) => void;
  /**
   * stageOpeningBids replays the calls that were already on the tray before
   * a non-dealer opened the board, one at a time from an empty auction — see
   * Board.tsx. Left alone, the table itself would grow a new row partway
   * through that replay (as soon as the padded first row fills up), which
   * shifts everything below it — the decision cluster hugs the dock's top
   * edge (margin-top: auto), so a row appearing mid-reveal slides the hand
   * and feedback down the screen and back before the player has even acted.
   * `reserveThrough` is the auction length the reveal is BUILDING TOWARD
   * (known upfront — see stageOpeningBids), so the row count is computed
   * from that target rather than from `auction.length` alone: the table is
   * already at its settled height on the empty first frame, and calls fill
   * blank cells within it as they arrive instead of adding rows. Omitted (or
   * lower than `auction.length`) for ordinary play, where the auction
   * genuinely growing turn by turn is the whole point.
   */
  reserveThrough?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [auction.length]);

  const total = Math.max(auction.length, reserveThrough ?? 0);
  const rows: (AuctionEntry | null)[][] = [];
  let row: (AuctionEntry | null)[] = new Array(dealer).fill(null);
  for (let i = 0; i < total; i++) {
    row.push(auction[i] ?? null);
    if (row.length === 4) {
      rows.push(row);
      row = [];
    }
  }
  // my pending call renders as the outlined "?" in my column (seat 2 = South)
  const pending = myTurn ? (dealer + auction.length) % 4 : -1;
  if (myTurn) {
    while (row.length < pending) row.push(null);
  }
  if (row.length || myTurn) rows.push([...row, ...new Array(4 - row.length).fill(null)]);
  if (!rows.length) rows.push([null, null, null, null]);
  const lastRow = rows.length - 1;
  // Cells are keyed positionally and empties render null, so an arriving call
  // mounts a brand-new <button> and a CSS animation on it fires with no JS.
  // Restricting it to the newest entry is what stops a whole auction cascading
  // in on the grid's own first mount.
  const newest = live ? auction[auction.length - 1] : null;

  return (
    <div className="auction">
      <div className="auction-inner">
        <div className="auction-scroll" ref={scrollRef}>
          <table>
            <thead>
              <tr>
                <th>N</th>
                <th>E</th>
                <th className="auction-me">S ★</th>
                <th>W</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((entry, j) => (
                    <td key={j}>
                      {entry ? (
                        <button
                          type="button"
                          className={[entry.meaning?.exact ? 'has-meaning' : '', entry === newest ? 'auction-latest' : '']
                            .filter(Boolean)
                            .join(' ')}
                          onClick={() => onInspect(entry)}
                          title="what does this call mean?"
                          aria-label={entry.name}
                        >
                          <CallText call={entry.call} />
                        </button>
                      ) : i === lastRow && j === pending ? (
                        <span className="auction-pending">?</span>
                      ) : (
                        // A blank cell renders nothing, but a called one renders a
                        // button with its own padding/min-height — table rows size
                        // to their tallest cell, so a row sat shorter than its
                        // buttons until the first call landed in it, then visibly
                        // grew. This invisible placeholder matches that button's
                        // box model so every reserved row is already at its real
                        // height on the empty first frame (see reserveThrough).
                        <span className="auction-blank" aria-hidden="true" />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="auction-hint">dotted = exact SAYC meaning · tap any call to inspect</div>
      </div>
    </div>
  );
}
