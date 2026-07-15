import { BridgeMark } from './BridgeMark';

/** Full-width loading treatment: pulsing bridge glyph over a tracked-caps label. */
export function Loading({ label = 'LOADING' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <BridgeMark width={40} />
      <span className="label-caps">{label}</span>
    </div>
  );
}
