/** Flip-digit turnstile numerals — hero numbers only (MP%, rating).
 * @startingPoint section="Brand" subtitle="Turnstile hero numerals" viewport="240x110" */
export interface FlipDigitsProps {
  /** Digits to show, e.g. "58" or "1487" */ value?: string;
  /** Outlined trailing cell, e.g. "%" — pass "" for none */ suffix?: string;
  /** Cell height in px (default 44; result hero uses 54) */ size?: number;
  style?: React.CSSProperties;
}
export function FlipDigits(props: FlipDigitsProps): JSX.Element;