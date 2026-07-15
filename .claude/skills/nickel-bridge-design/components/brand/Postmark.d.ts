/** Circular postmark + wave cancel — result screens only; cancels a board/tournament like a mailed ticket.
 * @startingPoint section="Brand" subtitle="Postmark cancel" viewport="240x140" */
export interface PostmarkProps {
  /** Top arc text */ arcTop?: string;
  /** Bottom arc text, e.g. "TOURNAMENT Nº12" */ arcBottom?: string;
  /** Center line 1 (stamp face) */ line1?: string;
  /** Center line 2 (date) */ line2?: string;
  /** Circle diameter px */ size?: number;
  style?: React.CSSProperties;
}
export function Postmark(props: PostmarkProps): JSX.Element;