import { useState } from 'react';
import { shortDateUTC } from '../../format';

export interface DayGridPoint {
  /** UTC calendar day, 'YYYY-MM-DD' */
  date: string;
  count: number;
}

/** Trailing window shown by default — a width-budget-driven guess (fits the
 *  same 326px design width as Sparkline at a legible cell size), not a
 *  data-driven choice like pctSeries's "last 10 tournaments". */
export const DAYGRID_WEEKS = 18;

const MS_PER_DAY = 86_400_000;
const CELL_GAP = 3; // svg user units
const DESIGN_W = 326; // matches Sparkline's W, same visual rhythm on the page

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Sunday-start UTC week window ending on the Saturday of `today`'s week, so
 * the grid only reshapes once a week (not once a day) and every column is a
 * full week — no ragged trailing edge.
 */
export function dayWindow(weeks: number, today: Date): { start: Date; end: Date } {
  const todayUTC = utcMidnight(today);
  const end = new Date(todayUTC.getTime() + (6 - todayUTC.getUTCDay()) * MS_PER_DAY);
  const start = new Date(end.getTime() - (weeks * 7 - 1) * MS_PER_DAY);
  return { start, end };
}

/**
 * Sum of `count` for days falling inside the same trailing window `DayGrid`
 * itself would draw for these args — callers (Player.tsx) use this to print
 * a window-consistent total without re-deriving the windowing math.
 */
export function sumInWindow(days: DayGridPoint[], weeks: number = DAYGRID_WEEKS, today: Date = new Date()): number {
  const { start, end } = dayWindow(weeks, today);
  const startYMD = toYMD(start);
  const endYMD = toYMD(end);
  return days.filter((d) => d.date >= startYMD && d.date <= endYMD).reduce((s, d) => s + d.count, 0);
}

/** 'YYYY-MM-DD' → unix seconds at UTC midnight, for reuse with format.ts's shortDateUTC. */
export function dateToUnix(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 1000;
}

const boardsLabel = (count: number) => (count === 0 ? 'no boards' : `${count} board${count === 1 ? '' : 's'}`);

interface Cell {
  date: string;
  count: number | null; // null = future, not yet playable
  col: number;
  row: number; // 0 = Sunday .. 6 = Saturday
}

/**
 * GitHub-punch-card-style day grid: one cell per UTC calendar day over a
 * trailing multi-week window, ink density (fill-opacity on --ink, not a
 * quality-coded color) standing in for board count that day. Deliberately
 * toll-vocabulary-free — like Sparkline, it renders plain "board(s)" copy
 * and leaves the "toll" framing to the panel that wraps it (Player.tsx).
 */
export function DayGrid({
  days,
  weeks = DAYGRID_WEEKS,
  today = new Date(),
}: {
  /** sparse — only days with count > 0 need appear, any order */
  days: DayGridPoint[];
  weeks?: number;
  /** inject "now" for tests; defaults to the real current time */
  today?: Date;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const byDate = new Map(days.map((d) => [d.date, d.count]));
  const { start } = dayWindow(weeks, today);
  const todayYMD = toYMD(utcMidnight(today));

  const cells: Cell[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start.getTime() + i * MS_PER_DAY);
    const date = toYMD(d);
    const future = date > todayYMD;
    cells.push({ date, count: future ? null : byDate.get(date) ?? 0, col: Math.floor(i / 7), row: i % 7 });
  }

  const maxCount = Math.max(1, ...cells.map((c) => c.count ?? 0));
  const level = (count: number) => (count === 0 ? 0 : Math.min(4, Math.ceil((count / maxCount) * 4)));

  const cellSize = (DESIGN_W - (weeks - 1) * CELL_GAP) / weeks;
  const H = 7 * cellSize + 6 * CELL_GAP;
  const x = (col: number) => col * (cellSize + CELL_GAP);
  const y = (row: number) => row * (cellSize + CELL_GAP);

  return (
    <div className="daygrid">
      <div className="daygrid-plot">
        <svg width="100%" height={H} viewBox={`0 0 ${DESIGN_W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {cells.map((c) => (
            <rect
              key={c.date}
              x={x(c.col)}
              y={y(c.row)}
              width={cellSize}
              height={cellSize}
              rx="1.5"
              className={c.count === null ? 'daygrid-cell future' : `daygrid-cell level-${level(c.count)}`}
            />
          ))}
        </svg>
        <div className="daygrid-hits">
          {cells.map((c) => {
            const style = {
              left: `${(c.col / weeks) * 100}%`,
              top: `${(c.row / 7) * 100}%`,
              width: `${(1 / weeks) * 100}%`,
              height: `${(1 / 7) * 100}%`,
            };
            return c.count === null ? (
              <div key={c.date} style={style} />
            ) : (
              <button
                key={c.date}
                type="button"
                style={style}
                aria-label={`${shortDateUTC(dateToUnix(c.date))} — ${boardsLabel(c.count)}`}
                aria-pressed={selected === c.date}
                onClick={() => setSelected(selected === c.date ? null : c.date)}
              />
            );
          })}
        </div>
      </div>
      <div className="daygrid-captions">
        <span>{shortDateUTC(dateToUnix(toYMD(start)))}</span>
        <span className="daygrid-legend">
          fewer
          <svg aria-hidden="true" width="58" height="11" viewBox="0 0 58 11">
            {[0, 1, 2, 3, 4].map((lvl) => (
              <rect key={lvl} x={lvl * 12} y="0" width="10" height="10" rx="1.5" className={`daygrid-cell level-${lvl}`} />
            ))}
          </svg>
          more
        </span>
        <span>this week</span>
      </div>
      {selected !== null ? (
        <div className="daygrid-detail num">
          {shortDateUTC(dateToUnix(selected))} · {boardsLabel(byDate.get(selected) ?? 0)}
        </div>
      ) : null}
    </div>
  );
}
