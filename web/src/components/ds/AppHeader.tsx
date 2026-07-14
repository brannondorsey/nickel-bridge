import { Link } from 'react-router-dom';
import { BridgeMark } from './BridgeMark';

/** Top chrome: glyph + Poiret wordmark linking home, right-side tracked-caps context. */
export function AppHeader({ context = 'DUPLICATE · SAYC' }: { context?: string }) {
  return (
    <header className="appheader">
      <Link to="/" className="appheader-brand">
        <BridgeMark width={26} />
        <span className="wordmark">NICKEL BRIDGE</span>
      </Link>
      <span className="appheader-context">{context}</span>
    </header>
  );
}

/** Sub-screen header: back chevron + Besley title, right-side caption. */
export function ScreenHeader({ title, caption, onBack }: { title: string; caption?: string; onBack?: () => void }) {
  return (
    <header className="screenheader">
      <div className="screenheader-lead">
        {onBack ? (
          <button type="button" className="screenheader-back" aria-label="Back" onClick={onBack}>
            ‹
          </button>
        ) : null}
        <span className="screenheader-title">{title}</span>
      </div>
      {caption ? <span className="screenheader-caption">{caption}</span> : null}
    </header>
  );
}
