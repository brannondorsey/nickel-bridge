/** The two brand marks. variant="glyph" (header) | "footer" (colophon). The splash river scene is a separate asset. */
export function BridgeMark({ variant = 'glyph', width }: { variant?: 'glyph' | 'footer'; width?: number }) {
  if (variant === 'footer') {
    const w = width ?? 180;
    return (
      <svg width={w} height={Math.round((w * 46) / 320)} viewBox="0 0 320 46" aria-hidden="true">
        <g stroke="var(--verdigris)" fill="none">
          <line x1="0" y1="5" x2="320" y2="5" strokeWidth="5" />
          <path d="M12 40 Q60 16 108 40 Q156 16 204 40 Q252 16 300 40" strokeWidth="3.5" />
          <line x1="12" y1="5" x2="12" y2="40" strokeWidth="3.5" />
          <line x1="108" y1="5" x2="108" y2="40" strokeWidth="3.5" />
          <line x1="204" y1="5" x2="204" y2="40" strokeWidth="3.5" />
          <line x1="300" y1="5" x2="300" y2="40" strokeWidth="3.5" />
          <line x1="60" y1="5" x2="60" y2="28" strokeWidth="2" />
          <line x1="156" y1="5" x2="156" y2="28" strokeWidth="2" />
          <line x1="252" y1="5" x2="252" y2="28" strokeWidth="2" />
        </g>
      </svg>
    );
  }
  const w = width ?? 26;
  return (
    <svg width={w} height={Math.round((w * 122) / 160)} viewBox="0 0 160 122" aria-hidden="true">
      <g stroke="var(--verdigris)" fill="none">
        <line x1="0" y1="10" x2="160" y2="10" strokeWidth="14" />
        <path d="M8 112 Q80 38 152 112" strokeWidth="10" />
        <line x1="8" y1="10" x2="8" y2="112" strokeWidth="10" />
        <line x1="152" y1="10" x2="152" y2="112" strokeWidth="10" />
        <line x1="80" y1="10" x2="80" y2="75" strokeWidth="7" />
      </g>
    </svg>
  );
}
