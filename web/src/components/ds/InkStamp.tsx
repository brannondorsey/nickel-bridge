import type { CSSProperties, ReactNode } from 'react';

/** Oval ink stamp for statuses. Rotation + ink-fade mask are part of the treatment. */
export function InkStamp({
  children,
  color = 'var(--ink)',
  rotate = -5,
  fade = 'right',
  className = '',
}: {
  children: ReactNode;
  color?: string;
  rotate?: number;
  fade?: 'left' | 'right';
  className?: string;
}) {
  const style = { '--stamp-color': color, '--stamp-rotate': `${rotate}deg` } as CSSProperties;
  return (
    <span className={`ink-stamp ink-stamp-fade-${fade} ${className}`.trim()} style={style}>
      {children}
    </span>
  );
}
