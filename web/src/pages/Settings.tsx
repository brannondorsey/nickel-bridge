import { useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useMe } from '../App';
import { SUIT_SYMBOLS, api, suitClass } from '../api';
import { AppHeader } from '../components/ds/AppHeader';
import { Button } from '../components/ds/Button';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { TABLE_SPEED_DEFAULT, TABLE_SPEED_MAX, TABLE_SPEED_MIN } from '../components/game/playAnim';
import { applySuitPalette, readSuitPalette, storeSuitPalette, type SuitPalette } from '../suitPalette';
import { applyThemePref, readThemePref, storeThemePref, type ThemePref } from '../theme';

/**
 * The settings gate.
 *
 * One panel, one row per preference: tracked-caps label, the aside that says
 * what the setting actually does, then a full-width control. Every row is
 * mostly the same control at a different arity — four segments for
 * appearance, two for the switches — with Table speed the one exception: a
 * genuinely continuous drag slider, since "how fast" is a continuum a
 * segmented lever can't represent as legibly as a track + thumb can.
 *
 * Everything here is account state (columns on `users`, written through
 * POST /api/me/prefs) EXCEPT appearance and suit colors, which are device-local
 * because they have to be applied before first paint by the inline scripts in
 * index.html — no server round trip can answer in time, and both a person's
 * screen at 11 PM and how they read a suit glyph are properties of the device
 * they're on rather than of their account. The footer says that once rather
 * than tagging individual rows.
 *
 * The four account controls are optimistic: they move under the finger and
 * revert if the write is refused, since a control that waits on a round trip
 * before moving reads as dead on a slow connection. The slider's drag needs
 * this split further than a switch does — see TableSpeedSlider's own doc
 * comment for why the local drag state and the server-committed value are
 * deliberately two different pieces of state.
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

// Caption-only, unlike PrefSwitch's segments — there's no discrete "which
// one is active" the way a stepped control has, so these three just mark
// the track's low end, midpoint, and high end (TABLE_SPEED_MIN/DEFAULT/MAX).
// The thumb's own position is what actually communicates the value.
const TABLE_SPEED_LABELS = ['SLOW', 'NORMAL', 'FAST'];

// 100 steps across the full MIN..MAX range: fine enough to read as a smooth
// drag, coarse enough that a keyboard arrow step (which moves by exactly one
// `step`) is a sensible, visible increment rather than an imperceptible
// nudge or (with the browser's step="any" fallback of 1) a jump clear from
// NORMAL to an endpoint in a single keypress.
const TABLE_SPEED_STEP = (TABLE_SPEED_MAX - TABLE_SPEED_MIN) / 100;

/** aria-valuetext bucket — screen readers get a word, not a raw float. */
function tableSpeedValueText(v: number): string {
  if (v < -0.05) return 'Slower than normal';
  if (v > 0.05) return 'Faster than normal';
  return 'Normal';
}

/**
 * A native <input type="range"> in the toll-bridge idiom: a 1px ink track,
 * a square ink thumb (the same "filled ink plate" look PrefSwitch gives its
 * active segment), and tracked-caps SLOW/NORMAL/FAST captions underneath —
 * the slider's equivalent of a segmented lever's row of buttons, marking
 * the track's ends and midpoint rather than being the tappable surface
 * itself.
 *
 * `value` is the CURRENT DRAG POSITION, updated on every native `input`
 * tick so the thumb tracks the finger/cursor with no lag — a controlled
 * range input that only updated on commit would visibly fight the drag,
 * snapping back between ticks. `onCommit` fires once, on release (mouseup/
 * touchend) or after a keyboard step (keyup) — reading the value directly
 * off the DOM element (e.currentTarget.value) rather than closing over
 * React state, so it can never fire with a stale position from a prior
 * render. The caller (Settings' change()) is what actually knows the
 * difference between "where the thumb is" and "what the account has saved"
 * — see change()'s own comment.
 */
function TableSpeedSlider({
  value,
  onChange,
  onCommit,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const commit = (e: SyntheticEvent<HTMLInputElement>) => onCommit(Number(e.currentTarget.value));
  return (
    <div className="ds-slider">
      <input
        type="range"
        className="ds-slider-input"
        min={TABLE_SPEED_MIN}
        max={TABLE_SPEED_MAX}
        step={TABLE_SPEED_STEP}
        value={value}
        aria-label="Table speed"
        aria-valuetext={tableSpeedValueText(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
      />
      <div className="ds-slider-ticks" aria-hidden="true">
        {TABLE_SPEED_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function SettingRow({ label, note, children }: { label: string; note: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <span className="setting-label">{label}</span>
      <p className="setting-note">{note}</p>
      {children}
    </div>
  );
}

type AccountPrefs = { ladderListed: boolean; fastForward: boolean; tableSpeed: number; bidFeedback: boolean };

export default function Settings() {
  const { me, refresh } = useMe();
  const [theme, setTheme] = useState<ThemePref>(() => readThemePref());
  const [suitPalette, setSuitPalette] = useState<SuitPalette>(() => readSuitPalette());
  const [prefs, setPrefs] = useState<AccountPrefs>({
    ladderListed: me?.user?.ladderListed !== false,
    fastForward: me?.user?.fastForward !== false,
    tableSpeed: me?.user?.tableSpeed ?? TABLE_SPEED_DEFAULT,
    bidFeedback: me?.user?.bidFeedback !== false,
  });
  const [prefError, setPrefError] = useState<string | null>(null);

  // change() is for the switches ONLY — never route tableSpeed through it.
  // It captures its revert target from `prefs[key]` at call time, which is
  // correct for a switch (one click == one atomic commit, so prefs hasn't
  // moved since the click), but would be wrong for the slider: by the time
  // a drag's onCommit fires, prefs.tableSpeed has already been updated by
  // every onChange tick along the way, so `prefs.tableSpeed` at commit time
  // IS the new value, not the one to revert to. See committedTableSpeedRef
  // and commitTableSpeed below for the slider's own version of this.
  const change = async (patch: Partial<Omit<AccountPrefs, 'tableSpeed'>>) => {
    const revert: Partial<Omit<AccountPrefs, 'tableSpeed'>> = {};
    for (const key of Object.keys(patch) as (keyof Omit<AccountPrefs, 'tableSpeed'>)[]) revert[key] = prefs[key];
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

  // The slider's own revert target: the last value the ACCOUNT actually
  // confirmed, kept out of React state on purpose so dragging (which moves
  // prefs.tableSpeed on every tick, for a lag-free thumb) never overwrites
  // it. Only commitTableSpeed's success path moves it.
  const committedTableSpeedRef = useRef(prefs.tableSpeed);
  const commitTableSpeed = async (tableSpeed: number) => {
    const prevCommitted = committedTableSpeedRef.current;
    setPrefs((p) => ({ ...p, tableSpeed }));
    setPrefError(null);
    try {
      await api.setPrefs({ tableSpeed });
      committedTableSpeedRef.current = tableSpeed;
      refresh();
    } catch {
      committedTableSpeedRef.current = prevCommitted;
      setPrefs((p) => ({ ...p, tableSpeed: prevCommitted }));
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
            label="Table speed"
            note="How quickly the robots play their cards once the bidding ends. Normal is today's table speed either way — slide left to slow the hand down, right to move it along."
          >
            <TableSpeedSlider
              value={prefs.tableSpeed}
              onChange={(tableSpeed) => setPrefs((p) => ({ ...p, tableSpeed }))}
              onCommit={commitTableSpeed}
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
            Appearance and suit colors are kept on this device; the rest travels with your account.
          </p>
        </div>
      </div>
    </div>
  );
}
