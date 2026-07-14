import { useEffect, useState } from 'react';
import { Me, api } from '../api';
import { useMe } from '../App';

export default function Login() {
  const { refresh } = useMe();
  const [info, setInfo] = useState<Me | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    api.me().then(setInfo);
  }, []);

  return (
    <div className="login">
      <div className="suits">
        ♠<span className="r">♥</span>♣<span className="r">♦</span>
      </div>
      <h1>Nickel Bridge</h1>
      <p style={{ color: 'var(--muted)', margin: 0 }}>
        Learn SAYC bidding and play four-deal duplicate tournaments with your friends — robot partner and opponents,
        real rankings.
      </p>
      {info?.googleAuth !== false ? (
        <a className="btn btn-primary" href="/auth/google">
          Sign in with Google
        </a>
      ) : null}
      {info?.devAuth ? (
        <>
          <input placeholder="Name (dev login)" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            className="btn btn-secondary"
            onClick={async () => {
              if (!name.trim()) return;
              await api.devLogin(name.trim());
              refresh();
            }}
          >
            Dev sign-in
          </button>
        </>
      ) : null}
    </div>
  );
}
