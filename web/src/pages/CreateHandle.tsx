import { useState } from 'react';
import { useMe } from '../App';
import { api } from '../api';
import { Button } from '../components/ds/Button';
import { Input } from '../components/ds/Input';

/**
 * One-time interstitial after first sign-in: pick the name everyone else sees. Also carries
 * the app's only newcomer-orientation copy (what SAYC and duplicate scoring mean) — it's the
 * one screen every new player sees exactly once before landing in a live auction. A future
 * Learning feature should replace this paragraph outright rather than build alongside it.
 */
export default function CreateHandle({ initialHandle = '' }: { initialHandle?: string }) {
  const { refresh } = useMe();
  const [handle, setHandleValue] = useState(initialHandle);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = handle.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.setHandle(trimmed);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to set handle');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="splash-word">NICKEL BRIDGE</div>
      <div className="splash-sub">DUPLICATE · SAYC</div>
      <h1 className="auth-title">Choose your handle</h1>
      <p className="auth-copy">
        This is the name your friends will see everywhere — leaderboard, standings, and stats. Pick anything, up to
        24 characters.
      </p>
      <p className="auth-copy">
        Your robot partner and opponents bid SAYC — a standard bidding language, so every call always means the same
        thing. Scoring is duplicate: everyone in your field plays the identical deals, so the ranking rewards skill,
        not the luck of the cards.
      </p>
      <div className="auth-actions">
        <Input
          placeholder="Handle"
          value={handle}
          onChange={setHandleValue}
          onEnter={submit}
          error={error}
          maxLength={24}
          autoFocus
        />
        <Button onClick={submit} disabled={!handle.trim()} busy={busy} busyLabel="Saving…">
          Continue
        </Button>
      </div>
    </div>
  );
}
