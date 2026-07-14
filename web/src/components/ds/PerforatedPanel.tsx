import type { ReactNode } from 'react';

/** Perforated panel — the base "card"; dashed tear line inside the left edge. */
export function PerforatedPanel({
  children,
  heading,
  dashed = false,
  className = '',
}: {
  children: ReactNode;
  heading?: ReactNode;
  dashed?: boolean;
  className?: string;
}) {
  return (
    <div className={`perf-panel ${dashed ? 'perf-panel-dashed' : ''} ${className}`.trim()}>
      {heading ? <div className="label-caps perf-panel-heading">{heading}</div> : null}
      {children}
    </div>
  );
}
