import { Button } from '../components/ds/Button';
import { Postmark } from '../components/ds/Postmark';
import { postmarkDate } from '../format';

/**
 * The catch-all for any URL that doesn't match a route — a typo, a stale
 * bookmark, or a link to since-removed content. Reuses the Postmark's
 * existing "REFUSED" stamp (already shown on a result screen when your side
 * goes down) rather than inventing a new motif for "no."
 */
export default function NotFound() {
  return (
    <div className="notfound-page">
      <div className="label-caps">AT THE GATE</div>
      <Postmark size={120} arcBottom="AT THE GATE" line1="REFUSED" line2={postmarkDate(Date.now() / 1000)} />
      <h1 className="notfound-title">This page does not exist.</h1>
      <p className="notfound-hint">
        The address you followed doesn't lead anywhere on the bridge — it may be old, or was never issued.
      </p>
      <div className="notfound-actions">
        <Button to="/">BACK TO THE BRIDGE →</Button>
      </div>
    </div>
  );
}
