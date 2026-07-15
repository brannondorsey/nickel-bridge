/** Perforated-edge panel — the system's base container for ledgers, field tables, meaning boxes.
 * @startingPoint section="Brand" subtitle="Base ledger panel" viewport="320x140" */
export interface PerforatedPanelProps {
  children?: React.ReactNode;
  /** Optional tracked-caps Besley heading */ heading?: string;
  /** Sealed/unavailable variant (dashed, muted) */ dashed?: boolean;
  /** CSS padding override */ padding?: string;
  style?: React.CSSProperties;
}
export function PerforatedPanel(props: PerforatedPanelProps): JSX.Element;