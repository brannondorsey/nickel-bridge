import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface TrendPoint {
  label: string;
  value: number;
  date?: number | null; // unixepoch seconds
}

interface Props {
  points: TrendPoint[];
  yDomain?: [number, number];
  refValue?: number;
  refLabel?: string;
  /** overlay a trailing-mean trend line with this window */
  trendWindow?: number;
  format?: (v: number) => string;
}

const fmtDate = (t: number) =>
  new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function TrendTooltip({ active, payload, format }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="trend-tip">
      <b>{format(p.value)}</b>
      <span>
        {p.label}
        {p.date ? ` · ${fmtDate(p.date)}` : ''}
      </span>
    </div>
  );
}

/**
 * Single-series line over evenly spaced tournaments (index x-axis: play order
 * is the learning timeline; real dates cluster badly and live in the tooltip).
 */
export default function TrendChart({ points, yDomain, refValue, refLabel, trendWindow, format }: Props) {
  const fmt = format ?? ((v: number) => String(Math.round(v)));
  const data = points.map((p, i) => ({
    ...p,
    i,
    trend:
      trendWindow && points.length >= 3
        ? avg(points.slice(Math.max(0, i - trendWindow + 1), i + 1).map((q) => q.value))
        : undefined,
  }));

  const first = points[0]?.date;
  const last = points[points.length - 1]?.date;

  return (
    <div className="trend">
      <ResponsiveContainer width="100%" height={170}>
        <LineChart data={data} margin={{ top: 16, right: 12, bottom: 0, left: -18 }}>
          <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="1 3" />
          <XAxis
            dataKey="i"
            tickLine={false}
            axisLine={{ stroke: 'var(--line)' }}
            ticks={data.length > 1 ? [0, data.length - 1] : [0]}
            tickFormatter={(i: number) => {
              const d = i === 0 ? first : last;
              return d ? fmtDate(d) : '';
            }}
            tick={{ fontSize: 11, fill: 'var(--muted)' }}
          />
          <YAxis
            domain={yDomain ?? ['auto', 'auto']}
            tickLine={false}
            axisLine={false}
            width={58}
            tickFormatter={(v: number) => fmt(v)}
            tick={{ fontSize: 11, fill: 'var(--muted)' }}
          />
          <Tooltip content={<TrendTooltip format={fmt} />} cursor={{ stroke: 'var(--line)' }} />
          {refValue !== undefined && (
            <ReferenceLine
              y={refValue}
              stroke="var(--muted)"
              strokeDasharray="3 3"
              label={
                refLabel
                  ? { value: refLabel, position: 'insideBottomRight', fontSize: 10, fill: 'var(--muted)' }
                  : undefined
              }
            />
          )}
          {trendWindow && points.length >= 3 && (
            <Line
              dataKey="trend"
              stroke="var(--accent)"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          )}
          <Line
            dataKey="value"
            stroke="var(--felt)"
            strokeWidth={2}
            dot={{ r: 3, fill: 'var(--felt)', strokeWidth: 0 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
