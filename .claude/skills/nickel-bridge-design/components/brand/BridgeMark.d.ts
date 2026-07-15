/** The Nickel Bridge marks: verdigris glyph (chrome), footer span (colophon), river scene (splash only). */
export interface BridgeMarkProps {
  variant?: 'glyph' | 'footer' | 'scene';
  /** Rendered width px (glyph 26 header / 34 inline; footer 180) */ width?: number;
  /** Path to bridge-river-scene.svg for variant="scene" (project-relative by default) */ sceneSrc?: string;
  style?: React.CSSProperties;
}
export function BridgeMark(props: BridgeMarkProps): JSX.Element;