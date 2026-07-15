/** Ticket-stub counter — board/tourney progress rendered as an ADMIT ONE ticket.
 * @startingPoint section="Brand" subtitle="Ticket-stub counter" viewport="240x110" */
export interface TicketStubProps {
  /** Small tracked-caps line, e.g. "BOARD", "OPEN NOW" */ label?: string;
  /** Big Besley 800 line, e.g. "No. 2 of 4", "4 boards" */ value?: string;
  /** Rotated text on the stub edge */ edgeText?: string;
  /** Rendered width in px (66/184 aspect) */ width?: number;
  style?: React.CSSProperties;
}
export function TicketStub(props: TicketStubProps): JSX.Element;