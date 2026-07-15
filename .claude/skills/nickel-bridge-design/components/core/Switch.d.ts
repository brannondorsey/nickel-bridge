/** Switch — square track, square thumb, gate-like. (Intentional addition; styled to system.) */
export interface SwitchProps {
  label?: string; checked?: boolean; defaultChecked?: boolean;
  onChange?: (checked: boolean) => void; style?: React.CSSProperties;
}
export function Switch(props: SwitchProps): JSX.Element;