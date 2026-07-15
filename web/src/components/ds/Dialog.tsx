import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Bottom sheet over a scrim — the approved call-inspector treatment.
 * Adds the semantics the prototype's divs lacked: role=dialog, aria-modal,
 * Escape/scrim close, and focus moves to the close button on open.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-layer">
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <div className="sheet-title" id={titleId}>
            {title}
          </div>
          <button ref={closeRef} type="button" className="sheet-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer}
      </div>
    </div>
  );
}
