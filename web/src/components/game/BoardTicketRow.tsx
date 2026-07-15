import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { InkStamp } from '../ds/InkStamp';

/**
 * Ticket-style board row for the tournament sheet (and the Home gate row):
 * scored (solid, SCORED stamp, links to review), live (bold ticket shadow,
 * red LIVE stamp, links to play), sealed (dashed, inert).
 */
export function BoardTicketRow({
  no,
  state,
  main,
  sub,
  to,
  counterLabel = 'BOARD',
}: {
  no: number | string;
  state: 'scored' | 'live' | 'sealed';
  main: ReactNode;
  sub?: ReactNode;
  to?: string;
  counterLabel?: string;
}) {
  const stamp =
    state === 'scored' ? (
      <InkStamp rotate={-5}>SCORED</InkStamp>
    ) : state === 'live' ? (
      <InkStamp color="var(--suit-h)" rotate={3} fade="left">
        LIVE
      </InkStamp>
    ) : null;

  const body = (
    <>
      <div className="board-row-counter">
        <span className="board-row-counter-label">{counterLabel}</span>
        <span className="board-row-counter-no num">{no}</span>
      </div>
      <div className="board-row-main">
        {sub ? (
          <div className="board-row-text">
            <div className="board-row-title">{main}</div>
            <div className="board-row-sub num">{sub}</div>
          </div>
        ) : (
          <div className="board-row-sealed-text">{main}</div>
        )}
        {stamp}
      </div>
    </>
  );

  const cls = `board-row board-row-${state}`;
  if (to && state !== 'sealed') {
    return (
      <Link to={to} className={cls}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}
