/** Full-width action slab. Primary = ink block caps; secondary = outlined sentence case.
 * @startingPoint section="Core" subtitle="Ink slab actions" viewport="320x130" */
export interface ButtonProps {
  children?: React.ReactNode;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export function Button(props: ButtonProps): JSX.Element;