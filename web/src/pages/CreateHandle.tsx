import { useState } from 'react';
import { api } from '../api';
import { useMe } from '../App';

export default function CreateHandle() {
  const { refresh } = useMe();
  const [handle, setHandleValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = handle.trim();
    if (!trimmed) return;
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
    <div className="login">
      <div className="suits">
        ♠<span className="r">♥</span>♣<span className="r">♦</span>
      </div>
      <h1>Choose your handle</h1>
      <p style={{ color: 'var(--muted)', margin: 0 }}>
        This is the name your friends will see everywhere — leaderboard, standings, and stats. Pick anything, up to
        24 characters.
      </p>
      <input
        placeholder="Handle"
        value={handle}
        onChange={(e) => setHandleValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        autoFocus
      />
      {error ? <p style={{ color: 'var(--danger, #d33)', margin: 0 }}>{error}</p> : null}
      <button className="btn btn-primary" onClick={submit} disabled={busy || !handle.trim()}>
        {busy ? 'Saving…' : 'Continue'}
      </button>
    </div>
  );
}
