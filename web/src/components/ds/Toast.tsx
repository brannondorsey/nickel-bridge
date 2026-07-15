import type { ReactNode } from 'react';

/** Ticket-style toast with a dashed left perforation and an optional stamp slot. */
export function Toast({ children, stamp, className = '' }: { children: ReactNode; stamp?: ReactNode; className?: string }) {
  return (
    <div className={`toast ${className}`.trim()} role="status">
      <div className="toast-body">{children}</div>
      {stamp}
    </div>
  );
}
