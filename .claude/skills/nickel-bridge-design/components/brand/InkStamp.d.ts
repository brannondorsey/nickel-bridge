/** Oval rubber-stamp status badge — LIVE, SCORED, CONTINUE.
 * @startingPoint section="Brand" subtitle="Oval status stamp" viewport="200x90" */
export interface InkStampProps {
  /** Stamp text (caps) */ children?: React.ReactNode;
  /** Ink color: var(--ink), var(--suit-h) for LIVE, var(--suit-c) for go */ color?: string;
  /** Degrees, keep within ±6 */ rotate?: number;
  /** Which side the ink fades: 'left' | 'right' */ fade?: 'left' | 'right';
  /** Font size px (10 in lists, up to 17 standalone) */ size?: number;
  style?: React.CSSProperties;
}
export function InkStamp(props: InkStampProps): JSX.Element;