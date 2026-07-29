import { useState, type ReactNode } from 'react';
import { useMe } from '../App';
import { api } from '../api';
import { AppHeader } from '../components/ds/AppHeader';
import { Button } from '../components/ds/Button';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { readFastForward, storeFastForward } from '../prefs';
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
 * Where a preference LIVES is deliberately not visible here, and the rows are
 * ordered by it anyway: appearance and fast-forward are device-local
 * (localStorage, theme.ts and prefs.ts), while the ladder listing is account
 * state on the server. The footer says so once, quietly, rather than tagging
 * individual rows — someone reading this screen wants to know what changes,
 * not which storage answers for it.
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

export default function Settings() {
  const { me, refresh } = useMe();
  const [theme, setTheme] = useState<ThemePref>(() => readThemePref());
  const [fastForward, setFastForward] = useState(() => readFastForward());
  // Seeded from the session and updated optimistically: the switch must move
  // under the finger, and a failed write is reverted rather than left showing
  // a listing state the server never accepted.
  const [ladderListed, setLadderListed] = useState(me?.user?.ladderListed !== false);
  const [ladderError, setLadderError] = useState<string | null>(null);

  const changeLadder = async (listed: boolean) => {
    const previous = ladderListed;
    setLadderListed(listed);
    setLadderError(null);
    try {
      await api.setLadderListing(listed);
      refresh();
    } catch {
      setLadderListed(previous);
      setLadderError("That didn't save — try again.");
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
              value={fastForward}
              options={OFF_ON}
              onChange={(on) => {
                setFastForward(on);
                storeFastForward(on);
              }}
            />
          </SettingRow>

          <SettingRow
            label="Name on the ladder"
            note="Show your handle and rating to visitors who are not signed in. Signed-in players see the rankings either way."
          >
            <PrefSwitch label="Name on the ladder" value={ladderListed} options={OFF_ON} onChange={changeLadder} />
            {ladderError ? <div className="notice-error settings-error">{ladderError}</div> : null}
          </SettingRow>
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
            Appearance and fast-forward are kept on this device; your ladder listing travels with your account.
          </p>
        </div>
      </div>
    </div>
  );
}
