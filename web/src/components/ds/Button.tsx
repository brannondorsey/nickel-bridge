import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * Primary = ink slab, Josefin Sans 600 tracked caps; secondary = bordered
 * panel, same face (caps too — Josefin caps = pressable).
 * Renders a real <button>, or a <Link> when `to` is given. `busy` disables
 * and swaps the label (busyLabel) — the button never spins.
 */
export function Button({
  children,
  variant = 'primary',
  to,
  href,
  onClick,
  disabled = false,
  busy = false,
  busyLabel,
  className = '',
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  to?: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  className?: string;
}) {
  const cls = `ds-btn ${variant === 'secondary' ? 'ds-btn-secondary' : ''} ${className}`.trim();
  const content = busy && busyLabel ? busyLabel : children;
  if (to && !disabled && !busy) {
    return (
      <Link to={to} className={cls} onClick={onClick}>
        {content}
      </Link>
    );
  }
  if (href && !disabled && !busy) {
    return (
      <a href={href} className={cls} onClick={onClick}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled || busy}>
      {content}
    </button>
  );
}
