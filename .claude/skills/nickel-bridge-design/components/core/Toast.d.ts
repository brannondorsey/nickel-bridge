/** Ticket toast — perforated notice with optional InkStamp. (Intentional addition; styled to system.) */
export interface ToastProps {
  children?: React.ReactNode;
  /** Optional trailing element, typically an InkStamp */ stamp?: React.ReactNode;
  open?: boolean; style?: React.CSSProperties;
}
export function Toast(props: ToastProps): JSX.Element | null;