/** Checkbox — square ink box, filled when checked. (Intentional addition; styled to system.) */
export interface CheckboxProps {
  label?: string; checked?: boolean; defaultChecked?: boolean;
  onChange?: (checked: boolean) => void; style?: React.CSSProperties;
}
export function Checkbox(props: CheckboxProps): JSX.Element;