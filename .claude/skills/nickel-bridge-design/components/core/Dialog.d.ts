/** Bottom sheet over an ink scrim — the call-inspector pattern. Position:absolute — parent must be relative. */
export interface DialogProps {
  open?: boolean; title?: React.ReactNode; onClose?: () => void;
  children?: React.ReactNode; footer?: React.ReactNode; style?: React.CSSProperties;
}
export function Dialog(props: DialogProps): JSX.Element | null;