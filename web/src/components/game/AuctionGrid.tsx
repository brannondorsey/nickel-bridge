import { useEffect, useRef } from 'react';
import type { AuctionEntry } from '../../api';
import { CallText } from './CallText';

/**
 * The double-bordered auction frame. Rows are packed N/E/S/W with the first
 * row front-padded so the dealer's call lands in its column. Calls with a
 * SAYC meaning get the dotted underline; every call is a button that opens
 * the inspector. Long auctions scroll inside the frame (sticky header,
 * autoscrolled to the newest row).
 *
 * `stableHeight` fixes the scroll frame to a constant height (bidding only, via
 * `.auction-stable`): during the auction the table must not sink as each round
 * adds a row, or the bid box beneath it drifts down between turns. Play leaves
 * it off so the completed auction can use the full height it has room for.
 */
export function AuctionGrid({
  auction,
  dealer,
  myTurn,
  onInspect,
  stableHeight = false,
}: {
  auction: AuctionEntry[];
  dealer: number;
  myTurn: boolean;
  onInspect: (entry: AuctionEntry) => void;
  stableHeight?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [auction.length]);

  const rows: (AuctionEntry | null)[][] = [];
  let row: (AuctionEntry | null)[] = new Array(dealer).fill(null);
  for (const entry of auction) {
    row.push(entry);
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

  return (
    <div className={`auction${stableHeight ? ' auction-stable' : ''}`}>
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
                          className={entry.meaning?.exact ? 'has-meaning' : ''}
                          onClick={() => onInspect(entry)}
                          title="what does this call mean?"
                          aria-label={entry.name}
                        >
                          <CallText call={entry.call} />
                        </button>
                      ) : i === lastRow && j === pending ? (
                        <span className="auction-pending">?</span>
                      ) : null}
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
