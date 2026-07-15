/** Fact chip for bid meanings and constraints — "6–9 HCP", "DENIES 3 HEARTS". */
export interface ChipProps {
  children?: React.ReactNode;
  /** Muted variant for implied/secondary facts */ quiet?: boolean;
  /** Override border+text color (e.g. var(--suit-h)) */ color?: string;
  style?: React.CSSProperties;
}
export function Chip(props: ChipProps): JSX.Element;