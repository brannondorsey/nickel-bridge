/** 3-star bidding grade — unfilled stars stay visible in line gray. */
export interface StarGradeProps {
  /** 0–3 */ stars?: number; size?: number; style?: React.CSSProperties;
}
export function StarGrade(props: StarGradeProps): JSX.Element;