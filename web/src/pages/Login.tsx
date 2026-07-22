import { useState } from 'react';
import { useMe } from '../App';
import { api } from '../api';
import { Splash } from '../components/Splash';
import { Button } from '../components/ds/Button';
import { Input } from '../components/ds/Input';

/**
 * Logged-out users land on the splash itself: "PLAY THE TOLL →" is the
 * Google sign-in, with the dev name-only login below it when the server
 * enables it. Either auth option can be independently absent. No timer —
 * signing in is the only way across.
 */
export default function Login() {
  const { me, refresh } = useMe();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const devSignIn = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.devLogin(name.trim());
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'sign-in failed');
      setBusy(false);
    }
  };

  return (
    <Splash
      pitch="A century-old bridge by another name. It wasn't a nickel then and it isn't now. This bridge is not a bridge."
      cta={
        <>
          {me?.googleAuth !== false ? <Button href="/auth/google">PLAY THE TOLL →</Button> : null}
          {me?.devAuth ? (
            <>
              <Input
                placeholder="Name (dev login)"
                value={name}
                onChange={setName}
                onEnter={devSignIn}
                error={error}
              />
              <Button variant="secondary" onClick={devSignIn} busy={busy} busyLabel="SIGNING IN…">
                DEV SIGN-IN
              </Button>
            </>
          ) : null}
        </>
      }
    />
  );
}
