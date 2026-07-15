/** Corner-indexed playing card — white face, suit-signal color, soft shadow (the only one in the system).
 * @startingPoint section="Game" subtitle="Playing card" viewport="120x110" */
export interface PlayingCardProps {
  rank?: string;
  /** 'S' | 'H' | 'D' | 'C' */ suit?: string;
  /** Height px (hand 66, dummy 58, trick 52) */ size?: number;
  /** Muted suit color (dummy's off-lead suits) */ dimmed?: boolean;
  /** Lifted + ink border ("tap again to play") */ selected?: boolean;
  /** Dashed empty slot awaiting a card */ placeholder?: boolean;
  style?: React.CSSProperties;
}
export function PlayingCard(props: PlayingCardProps): JSX.Element;