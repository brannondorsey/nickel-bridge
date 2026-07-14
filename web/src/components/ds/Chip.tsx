import type { CSSProperties, ReactNode } from 'react';

/** Fact chip (HCP ranges, constraints, vulnerability). solid = ink border; quiet = gray, muted. */
export function Chip({
  children,
  quiet = false,
  color,
  className = '',
}: {
  children: ReactNode;
  quiet?: boolean;
  /** override border+text color (e.g. var(--suit-h) for the vul chip) */
  color?: string;
  className?: string;
}) {
  const style: CSSProperties | undefined = color ? ({ '--chip-color': color } as CSSProperties) : undefined;
  return (
    <span className={`chip ${quiet ? 'chip-quiet' : ''} ${color ? 'chip-colored' : ''} ${className}`.trim()} style={style}>
      {children}
    </span>
  );
}
