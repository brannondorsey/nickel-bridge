import { Button } from './Button';

/**
 * The bottom bar a logged-out visitor gets in place of the TabBar.
 *
 * The glossary is readable without an account (it's static reference data, and
 * it's the app's main search-engine entrance — see App.tsx's public-route
 * gate), so these readers arrive on a screen with no chrome that leads
 * anywhere. This is that chrome: it takes the TabBar's slot at the foot of the
 * shell and points at the one thing they can't do yet.
 *
 * It deliberately links to "/" rather than straight to /auth/google: the Login
 * screen already resolves which auth options this deployment actually has
 * (Google, the DEV_AUTH name-only form, or both), and duplicating that choice
 * here would be a second place to keep in sync.
 */
export function SignInBar() {
  return (
    <div className="signinbar">
      <p className="signinbar-note">Sign in to play for free.</p>
      <Button to="/">PLAY THE TOLL →</Button>
    </div>
  );
}
