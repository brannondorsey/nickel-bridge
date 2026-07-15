/** Select — square ink-bordered dropdown. (Intentional addition; styled to system.) */
export interface SelectProps {
  label?: string; value?: string; defaultValue?: string;
  options?: string[]; onChange?: (e: any) => void; style?: React.CSSProperties;
}
export function Select(props: SelectProps): JSX.Element;