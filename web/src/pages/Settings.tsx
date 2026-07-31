import { useState, type ReactNode } from 'react';
import { useMe } from '../App';
import { api } from '../api';
import { AppHeader } from '../components/ds/AppHeader';
import { Button } from '../components/ds/Button';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { applyThemePref, readThemePref, storeThemePref, type ThemePref } from '../theme';

/**
 * The settings gate.
 *
 * One panel, one row per preference: tracked-caps label, the aside that says
 * what the setting actually does, then a full-width segmented lever. Every row
 * is the same control at a different arity — four segments for appearance, two
 * for the switches — so the screen reads as one printed form rather than as a
 * theme picker with toggles bolted under it.
 *
 * Everything here is account state (columns on `users`, written through
 * POST /api/me/prefs) EXCEPT appearance, which is device-local because it has
 * to be applied before first paint by the inline script in index.html — no
 * server round trip can answer in time, and a person's screen at 11 PM is a
 * property of the room they're in rather than of their account. The footer
 * says that once rather than tagging individual rows.
 *
 * The account switches are optimistic: they move under the finger and
 * revert if the write is refused, since a switch that waits on a round trip
 * before moving reads as a dead control on a slow connection.
 */

const THEME_OPTIONS: { pref: ThemePref; label: string }[] = [
  { pref: 'day', label: 'DAY' },
  { pref: 'night', label: 'NIGHT' },
  { pref: 'adaptive', label: 'ADAPT' },
  { pref: 'system', label: 'SYSTEM' },
];

/** The shared lever: n segments, the chosen one on the ink plate. */
function PrefSwitch<T>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="pref-switch" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          className={o.value === value ? 'active' : ''}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const OFF_ON = [
  { value: false, label: 'OFF' },
  { value: true, label: 'ON' },
];

function SettingRow({ label, note, children }: { label: string; note: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <span className="setting-label">{label}</span>
      <p className="setting-note">{note}</p>
      {children}
    </div>
  );
}

type AccountPrefs = { ladderListed: boolean; fastForward: boolean; bidFeedback: boolean };

export default function Settings() {
  const { me, refresh } = useMe();
  const [theme, setTheme] = useState<ThemePref>(() => readThemePref());
  const [prefs, setPrefs] = useState<AccountPrefs>({
    ladderListed: me?.user?.ladderListed !== false,
    fastForward: me?.user?.fastForward !== false,
    bidFeedback: me?.user?.bidFeedback !== false,
  });
  const [prefError, setPrefError] = useState<string | null>(null);

  const change = async (patch: Partial<AccountPrefs>) => {
    const revert: Partial<AccountPrefs> = {};
    for (const key of Object.keys(patch) as (keyof AccountPrefs)[]) revert[key] = prefs[key];
    setPrefs((p) => ({ ...p, ...patch }));
    setPrefError(null);
    try {
      await api.setPrefs(patch);
      refresh();
    } catch {
      // Revert only the key(s) this call touched — a concurrent, already-
      // succeeded write to a different key must not be clobbered back.
      setPrefs((p) => ({ ...p, ...revert }));
      setPrefError("That didn't save — try again.");
    }
  };

  return (
    <div className="settings-page">
      <AppHeader context="SETTINGS" />

      <div className="settings-body">
        <PerforatedPanel className="settings-panel">
          <SettingRow
            label="Appearance"
            note="Adaptive turns the lamps down from 9 PM to 7 AM. System follows this device."
          >
            <PrefSwitch
              label="Appearance"
              value={theme}
              options={THEME_OPTIONS.map((o) => ({ value: o.pref, label: o.label }))}
              onChange={(pref) => {
                setTheme(pref);
                storeThemePref(pref);
                applyThemePref(pref);
              }}
            />
          </SettingRow>

          <SettingRow
            label="Fast forward settled tricks"
            note="Once the cards can no longer change the result, the rest of the board is played out for you. On, it runs quickly; off, it plays at table speed."
          >
            <PrefSwitch
              label="Fast forward settled tricks"
              value={prefs.fastForward}
              options={OFF_ON}
              onChange={(fastForward) => change({ fastForward })}
            />
          </SettingRow>

          <SettingRow
            label="Name on the ladder"
            note="Show your handle and rating to visitors who are not signed in. Signed-in players see the rankings either way."
          >
            <PrefSwitch
              label="Name on the ladder"
              value={prefs.ladderListed}
              options={OFF_ON}
              onChange={(ladderListed) => change({ ladderListed })}
            />
          </SettingRow>

          <SettingRow
            label="Bid feedback"
            note="After a call, a toast grades it against the robot's own bid. Off keeps the toast out of the way — nothing about how the board is scored changes."
          >
            <PrefSwitch
              label="Bid feedback"
              value={prefs.bidFeedback}
              options={OFF_ON}
              onChange={(bidFeedback) => change({ bidFeedback })}
            />
          </SettingRow>
          {prefError ? <div className="notice-error settings-error">{prefError}</div> : null}
        </PerforatedPanel>

        <div className="settings-foot">
          <Button
            variant="secondary"
            onClick={async () => {
              await api.logout();
              refresh();
            }}
          >
            Sign out
          </Button>
          <p className="settings-foot-note">
            Appearance is kept on this device; the rest travels with your account.
          </p>
        </div>
      </div>
    </div>
  );
}
