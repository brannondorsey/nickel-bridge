import { useState, type ReactNode } from 'react';
import { useMe } from '../App';
import { SUIT_SYMBOLS, api, suitClass } from '../api';
import { AppHeader } from '../components/ds/AppHeader';
import { Button } from '../components/ds/Button';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { PrefSwitch } from '../components/ds/PrefSwitch';
import { applySuitPalette, readSuitPalette, storeSuitPalette, type SuitPalette } from '../suitPalette';
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
 * POST /api/me/prefs) EXCEPT appearance and suit colors, which are device-local
 * because they have to be applied before first paint by the inline scripts in
 * index.html — no server round trip can answer in time, and both a person's
 * screen at 11 PM and how they read a suit glyph are properties of the device
 * they're on rather than of their account. The footer says that once rather
 * than tagging individual rows.
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

const SUIT_PALETTE_OPTIONS: { pref: SuitPalette; label: string }[] = [
  { pref: 'standard', label: 'STANDARD' },
  { pref: 'colorblind', label: 'COLORBLIND' },
];

const OFF_ON = [
  { value: false, label: 'OFF' },
  { value: true, label: 'ON' },
];

const TRICK_CLEAR_OPTIONS: { value: 'auto' | 'tap'; label: string }[] = [
  { value: 'auto', label: 'AUTO' },
  { value: 'tap', label: 'TAP' },
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

type AccountPrefs = {
  ladderListed: boolean;
  fastForward: boolean;
  bidFeedback: boolean;
  betaFeatures: boolean;
  doubleTapBid: boolean;
  trickClearMode: 'auto' | 'tap';
};

export default function Settings() {
  const { me, refresh } = useMe();
  const [theme, setTheme] = useState<ThemePref>(() => readThemePref());
  const [suitPalette, setSuitPalette] = useState<SuitPalette>(() => readSuitPalette());
  const [prefs, setPrefs] = useState<AccountPrefs>({
    ladderListed: me?.user?.ladderListed !== false,
    fastForward: me?.user?.fastForward !== false,
    bidFeedback: me?.user?.bidFeedback !== false,
    betaFeatures: me?.user?.betaFeatures === true,
    // Fail CLOSED, unlike the three switches above — this preference defaults
    // off, so an absent/undefined value must read as off, not on.
    doubleTapBid: me?.user?.doubleTapBid === true,
    // Fail to 'auto' — the shipped behaviour before this setting existed —
    // rather than assuming the field is always present.
    trickClearMode: me?.user?.trickClearMode === 'tap' ? 'tap' : 'auto',
  });
  const [prefError, setPrefError] = useState<string | null>(null);

  const change = async (patch: Partial<AccountPrefs>) => {
    const revert: Partial<AccountPrefs> = {};
    // AccountPrefs mixes booleans with the trickClearMode enum, so a plain
    // `revert[key] = prefs[key]` can no longer be verified sound for a key
    // typed as the whole `keyof AccountPrefs` union — the write is narrowed
    // through Record<string, unknown> rather than widening every value here
    // to `unknown` on read.
    for (const key of Object.keys(patch) as (keyof AccountPrefs)[]) {
      (revert as Record<string, unknown>)[key] = prefs[key];
    }
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
            note="Adaptive turns the lamps down from 7 PM to 8 AM. System follows this device."
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
            label="Suit colors"
            note="Colorblind gives hearts a stamp-ink blue and diamonds a rust orange instead of red and gold, so a red-green deficiency can still read all four suits at a glance. Spades and clubs are unchanged."
          >
            <PrefSwitch
              label="Suit colors"
              value={suitPalette}
              options={SUIT_PALETTE_OPTIONS.map((o) => ({ value: o.pref, label: o.label }))}
              onChange={(pref) => {
                setSuitPalette(pref);
                storeSuitPalette(pref);
                applySuitPalette(pref);
              }}
            />
            <div className="suit-preview" aria-hidden="true">
              {SUIT_SYMBOLS.map((sym, i) => (
                <span key={sym} className={suitClass(i)}>
                  {sym}
                </span>
              ))}
            </div>
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
            label="Trick clearing"
            note="Auto sweeps a completed trick off the table on its own. Tap holds all four cards in place until you tap the trick area, so you can take your time reading it before it clears."
          >
            <PrefSwitch
              label="Trick clearing"
              value={prefs.trickClearMode}
              options={TRICK_CLEAR_OPTIONS}
              onChange={(trickClearMode) => change({ trickClearMode })}
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

          <SettingRow
            label="Beta features"
            note="Try screens still being tried out before they reach everyone — currently: Analyze, the after-the-fact review of a finished board's play."
          >
            <PrefSwitch
              label="Beta features"
              value={prefs.betaFeatures}
              options={OFF_ON}
              onChange={(betaFeatures) => change({ betaFeatures })}
            />
          </SettingRow>

          <SettingRow
            label="Double-tap to bid"
            note="A second tap on your selected call submits it immediately, without pressing Bid. Off by default, since that's the tap most mistaken bids come from — turn it on for the faster gesture once you trust it."
          >
            <PrefSwitch
              label="Double-tap to bid"
              value={prefs.doubleTapBid}
              options={OFF_ON}
              onChange={(doubleTapBid) => change({ doubleTapBid })}
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
            Appearance and suit colors are kept on this device; the rest travels with your account.
          </p>
        </div>
      </div>
    </div>
  );
}
