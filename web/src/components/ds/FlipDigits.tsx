/** Flip-digit numerals — turnstile counter for hero numbers only. */
export function FlipDigits({ value, suffix = '', size = 44 }: { value: string | number; suffix?: string; size?: number }) {
  const w = Math.round((size * 30) / 44);
  const fs = Math.round((size * 26) / 44);
  const sfs = Math.round((size * 22) / 44);
  const cell = { width: w, height: size };
  return (
    <div className="flipdigits num">
      {String(value)
        .split('')
        .map((ch, i) => (
          <div key={i} className="flipdigit" style={{ ...cell, fontSize: fs }}>
            {ch}
            <div className="flipdigit-seam" />
          </div>
        ))}
      {suffix ? (
        <div className="flipdigit flipdigit-suffix" style={{ ...cell, fontSize: sfs }}>
          {suffix}
        </div>
      ) : null}
    </div>
  );
}
