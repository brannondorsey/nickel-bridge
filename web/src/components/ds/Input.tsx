import { useId } from 'react';

/** Square-bordered text input with a Besley caps label and an inline error line. */
export function Input({
  label,
  value,
  onChange,
  onEnter,
  placeholder,
  error,
  maxLength,
  autoFocus,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  error?: string | null;
  maxLength?: number;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="ds-input">
      {label ? (
        <label className="label-caps" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) onEnter();
        }}
      />
      {error ? (
        <div className="ds-input-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
