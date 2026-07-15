/** App header (glyph + wordmark + context caps) and ScreenHeader (back + title) — the two chrome bars. */
export interface AppHeaderProps {
  /** Right-side tracked caps, e.g. "DUPLICATE · SAYC", "STATS" */ context?: string;
  showMark?: boolean; style?: React.CSSProperties;
}
export function AppHeader(props: AppHeaderProps): JSX.Element;
export interface ScreenHeaderProps {
  title?: string; caption?: string; onBack?: () => void; style?: React.CSSProperties;
}
export function ScreenHeader(props: ScreenHeaderProps): JSX.Element;