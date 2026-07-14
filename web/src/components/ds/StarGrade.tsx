/**
 * 0–3 star call grade. 0 renders a distinct ✗ in the negative color — never
 * three empty stars, which would read as "no data".
 */
export function StarGrade({ stars, size = 12 }: { stars: 0 | 1 | 2 | 3; size?: number }) {
  return (
    <span className="stargrade" style={{ fontSize: size }} aria-label={`${stars} of 3 stars`} role="img">
      {stars === 0 ? (
        <span className="stargrade-x">✗</span>
      ) : (
        <>
          {'★★★'.slice(0, stars)}
          <span className="stargrade-rest">{'★★★'.slice(stars)}</span>
        </>
      )}
    </span>
  );
}
