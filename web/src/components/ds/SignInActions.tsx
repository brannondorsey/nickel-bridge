import { useState } from 'react';
import { useMe } from '../../App';
import { api } from '../../api';
import { Button } from './Button';
import { Input } from './Input';

/**
 * The toll gate: whichever sign-in doors this deployment actually has.
 *
 * Both are independently optional — production runs Google only, local dev and
 * the preview apps add (or run purely on) the DEV_AUTH name-only form — and
 * /api/me reports which, for signed-out callers too. This is the single place
 * that reads those flags, so the several screens that now have to ask for a
 * sign-in can't drift apart on which options exist.
 *
 * `withDevForm` is not a style choice. Placing this twice on one page —
 * a hero CTA and a closing one — would put two identical name inputs and two
 * "DEV SIGN-IN" buttons in the document, and every test that reaches for one
 * by placeholder or role (App.test.tsx, auth.test.tsx, and Playwright's
 * strict page-level locators in e2e/smoke.spec.ts) fails on the ambiguity.
 * Exactly one placement per page carries the form; the rest pass false and
 * offer the Google door alone.
 *
 * `onSignIn` fires as the visitor leaves through either door. The landing
 * page doesn't need it; the first-crossing tour does, to record that this
 * person already walked it before they disappear into an OAuth redirect (see
 * onboarding/tourDone.ts).
 */
export function SignInActions({
  label = 'PLAY THE TOLL →',
  withDevForm = true,
  onSignIn,
}: {
  label?: string;
  withDevForm?: boolean;
  onSignIn?: () => void;
}) {
  const { me, refresh } = useMe();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const devSignIn = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    onSignIn?.();
    try {
      await api.devLogin(name.trim());
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'sign-in failed');
      setBusy(false);
    }
  };

  return (
    <>
      {me?.googleAuth !== false ? (
        // Wrapped, not passed straight through: Button forwards onClick to a
        // real DOM handler, so React would hand the callback a click event as
        // its first argument — and every optional-first-parameter helper on
        // the other end (stampTourDone's `now`) would quietly get an event
        // instead of a Date.
        <Button href="/auth/google" onClick={() => onSignIn?.()}>
          {label}
        </Button>
      ) : null}
      {me?.devAuth && withDevForm ? (
        <>
          <Input placeholder="Name (dev login)" value={name} onChange={setName} onEnter={devSignIn} error={error} />
          <Button variant="secondary" onClick={devSignIn} busy={busy} busyLabel="SIGNING IN…">
            DEV SIGN-IN
          </Button>
        </>
      ) : null}
    </>
  );
}
