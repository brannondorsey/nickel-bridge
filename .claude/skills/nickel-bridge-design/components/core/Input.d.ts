/** Text field — square, ink border, Besley tracked-caps label. (Intentional addition; styled to system.) */
export interface InputProps {
  label?: string; value?: string; defaultValue?: string; placeholder?: string;
  type?: string; onChange?: (e: any) => void; style?: React.CSSProperties;
}
export function Input(props: InputProps): JSX.Element;