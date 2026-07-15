/** Bottom tab bar — active tab gets an inset 3px ink bar, not a color change. */
export interface TabBarProps {
  tabs?: string[]; active?: string;
  onSelect?: (tab: string) => void; style?: React.CSSProperties;
}
export function TabBar(props: TabBarProps): JSX.Element;