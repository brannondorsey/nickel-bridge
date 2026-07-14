import { useId } from 'react';

/** Circular postmark + wave cancel. Result screens only. */
export function Postmark({
  arcTop = 'NICKEL BRIDGE',
  arcBottom = '',
  line1 = '',
  line2 = '',
  size = 104,
}: {
  arcTop?: string;
  arcBottom?: string;
  line1?: string;
  line2?: string;
  size?: number;
}) {
  const id = useId().replace(/:/g, '');
  const l1fs = String(line1).length > 6 ? 12 : 13;
  return (
    <div className="postmark">
      <svg width={size} height={size} viewBox="0 0 104 104">
        <circle cx="52" cy="52" r="49" fill="none" stroke="var(--ink)" strokeWidth="3" />
        <circle cx="52" cy="52" r="36" fill="none" stroke="var(--ink)" strokeWidth="1.5" />
        <defs>
          <path id={`pmT${id}`} d="M 14 52 A 38 38 0 0 1 90 52" />
          <path id={`pmB${id}`} d="M 12 52 A 40 40 0 0 0 92 52" />
        </defs>
        <text fontFamily="'Josefin Sans',sans-serif" fontWeight="600" fontSize="10.5" letterSpacing="2.5" fill="var(--ink)">
          <textPath href={`#pmT${id}`} startOffset="50%" textAnchor="middle">
            {arcTop}
          </textPath>
        </text>
        <text fontFamily="'Josefin Sans',sans-serif" fontWeight="600" fontSize="8.5" letterSpacing="2" fill="var(--ink)">
          <textPath href={`#pmB${id}`} startOffset="50%" textAnchor="middle">
            {arcBottom}
          </textPath>
        </text>
        <text x="52" y="49" textAnchor="middle" fontFamily="'Josefin Sans',sans-serif" fontWeight="600" fontSize={l1fs} letterSpacing="1" fill="var(--ink)">
          {line1}
        </text>
        <text x="52" y="63" textAnchor="middle" fontFamily="'Crimson Pro',serif" fontSize="10" fill="var(--ink)">
          {line2}
        </text>
      </svg>
      <svg width={Math.round(size * 0.62)} height={Math.round(size * 0.58)} viewBox="0 0 64 60" className="postmark-waves">
        <g stroke="var(--ink)" strokeWidth="2.5" fill="none">
          <path d="M0 8 Q16 2 32 8 T64 8" />
          <path d="M0 22 Q16 16 32 22 T64 22" />
          <path d="M0 36 Q16 30 32 36 T64 36" />
          <path d="M0 50 Q16 44 32 50 T64 50" />
        </g>
      </svg>
    </div>
  );
}
