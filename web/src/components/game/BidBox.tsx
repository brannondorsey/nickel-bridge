import { useMemo, useState } from 'react';
import { callDisplay } from '../../api';
import { CallText } from './CallText';

/**
 * The 38-call bid box. Levels 1–4 (20 targets) show by default; levels 5–7
 * live behind an in-place fold so the auction stays on screen. The fold
 * auto-expands when every legal leveled bid is above level 4 — otherwise a
 * high auction would show zero enabled bids. Two-step commit: select, then
 * the confirm CTA submits. Class names .bidbox/.bid/.callrow/.confirm-row
 * are selected on by the e2e smoke test.
 */
export function BidBox({
  legalCalls,
  selected,
  onSelect,
  onConfirm,
  busy,
}: {
  legalCalls: number[];
  selected: number | null;
  onSelect: (call: number) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const legal = useMemo(() => new Set(legalCalls), [legalCalls]);
  // calls 3..22 are levels 1–4; 23..37 are levels 5–7
  const mustExpand = useMemo(() => {
    const bids = legalCalls.filter((c) => c >= 3);
    return bids.length > 0 && bids.every((c) => c >= 23);
  }, [legalCalls]);
  const [expanded, setExpanded] = useState(false);
  const showHigh = expanded || mustExpand;

  const bidButton = (call: number) => (
    <button
      key={call}
      type="button"
      className={`bid${selected === call ? ' selected' : ''}`}
      disabled={!legal.has(call)}
      onClick={() => onSelect(call)}
      aria-label={callDisplay(call)}
    >
      <CallText call={call} />
    </button>
  );

  return (
    <div className="bidbox-wrap">
      <div className="bidbox">
        <div className="grid">{Array.from({ length: 20 }, (_, i) => i + 3).map(bidButton)}</div>
        {showHigh ? (
          <div className="grid">{Array.from({ length: 15 }, (_, i) => i + 23).map(bidButton)}</div>
        ) : (
          <button type="button" className="bidbox-fold" onClick={() => setExpanded(true)}>
            ▾ levels 5–7 below the fold ▾
          </button>
        )}
        <div className="callrow">
          {[0, 1, 2].map((call) => (
            <button
              key={call}
              type="button"
              className={`bid${selected === call ? ' selected' : ''}${call === 1 ? ' bid-x' : ''}`}
              disabled={!legal.has(call)}
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
