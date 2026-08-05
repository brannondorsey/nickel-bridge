/**
 * The shared segmented lever: n segments sharing the width, the chosen one on
 * the ink plate. The SAME component at every arity — the settings gate uses
 * it at four (appearance) and two (switch rows), the Analyze screen at three
 * (the lens switch) — which is deliberately why the design system still has
 * no separate on/off toggle. Lifted verbatim from Settings.tsx when Analyze
 * needed it; `.pref-switch` in style.css is arity-agnostic (flex: 1 per
 * segment).
 */
export function PrefSwitch<T>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="pref-switch" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          className={o.value === value ? 'active' : ''}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
