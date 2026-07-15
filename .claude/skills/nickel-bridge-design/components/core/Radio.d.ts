/** Radio group — ink ring + dot. (Intentional addition; styled to system.) */
export interface RadioProps {
  options?: string[]; value?: string; defaultValue?: string;
  onChange?: (value: string) => void; style?: React.CSSProperties;
}
export function Radio(props: RadioProps): JSX.Element;