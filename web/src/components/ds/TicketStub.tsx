/** Ticket-stub counter. Solid box, dashed perforation, rotated edge text. */
export function TicketStub({
  label = 'BOARD',
  value = '',
  edgeText = 'ADMIT ONE',
  width = 184,
}: {
  label?: string;
  value?: string;
  edgeText?: string;
  width?: number;
}) {
  const h = Math.round((width * 66) / 184);
  return (
    <svg width={width} height={h} viewBox="0 0 184 66" className="ticket-stub" aria-hidden={!label && !value}>
      <rect x="2" y="2" width="180" height="62" fill="var(--panel)" stroke="var(--ink)" strokeWidth="3" />
      <line x1="126" y1="2" x2="126" y2="64" stroke="var(--ink)" strokeWidth="2" strokeDasharray="3 5" />
      <text x="16" y="26" fontFamily="Besley,serif" fontWeight="700" fontSize="11" letterSpacing="3" fill="var(--ink)">
        {label}
      </text>
      <text x="16" y="52" fontFamily="Besley,serif" fontWeight="800" fontSize="24" fill="var(--ink)">
        {value}
      </text>
      <text x="146" y="14" fontFamily="Besley,serif" fontWeight="700" fontSize="10" letterSpacing="2" fill="var(--ink)" transform="rotate(90 146 14)">
        {edgeText}
      </text>
    </svg>
  );
}
