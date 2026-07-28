import type { ActivityEvent, ActivityResponse } from '../api';
import { timeGreeting } from '../format';

/**
 * Turning the activity feed's flat events into what the screen renders.
 *
 * Everything here is pure and lives outside the component on purpose: all of
 * it is timezone- and clock-dependent, and that is exactly the part worth
 * testing against fixed timestamps rather than eyeballing.
 *
 * THE VIEWER'S CLOCK IS THE ONLY CLOCK. The server stores UTC seconds and
 * knows nobody's timezone, so a day here is the viewer's calendar day
 * (getFullYear/getMonth/getDate, never toISOString, which would silently be
 * UTC) and the part of the day comes from timeGreeting() — reused unchanged
 * from the Home greeting so the two can never drift into disagreeing about
 * when evening starts. The consequence is deliberate and worth stating: a
 * player in Tokyo playing at midnight lands in a European viewer's afternoon.
 * The alternative is asking every player for a timezone.
 */

export const FEED_DAYS = 7;

/** Part of the day, on timeGreeting's 5 / 12 / 18 cutoffs. */
export type Block = 'morning' | 'afternoon' | 'evening';

/** One player's activity within one part of one day — the unit of a feed row. */
export interface Run {
  userId: number;
  handle: string;
  block: Block;
  /** latest event in the run, unix seconds — what the row's clock time shows */
  at: number;
  boards: number;
  /** summed over the run's crossings; null when none of them rated */
  eloDelta: number | null;
  crossings: Extract<ActivityEvent, { kind: 'crossing' }>[];
  milestones: Extract<ActivityEvent, { kind: 'milestone' }>[];
  joined: boolean;
}

export interface Day {
  /** local calendar day, 'YYYY-MM-DD' */
  dateKey: string;
  /** midnight local, unix seconds — what the strip measures hours from */
  startsAt: number;
  runs: Run[];
}

/** Local 'YYYY-MM-DD'. Deliberately not toISOString(), which is UTC. */
export function localDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** "Today" / "Yesterday" / "Saturday", for the day heading. */
export function dayLabel(dateKey: string, now: Date): string {
  const today = localDateKey(now);
  if (dateKey === today) return 'Today';
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dateKey === localDateKey(y)) return 'Yesterday';
  const [yr, mo, dy] = dateKey.split('-').map(Number);
  return new Date(yr, mo - 1, dy).toLocaleDateString('en-US', { weekday: 'long' });
}

/** "Thu · Jul 23", the right-hand side of the day heading. */
export function dayDate(dateKey: string): string {
  const [yr, mo, dy] = dateKey.split('-').map(Number);
  return new Date(yr, mo - 1, dy)
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    .replace(',', ' ·');
}

/**
 * Flat events → days → runs, newest first.
 *
 * The server sends a day more than we render (see its route comment) so that
 * the oldest day here is a whole one rather than a stub clipped by the
 * viewer's offset from UTC; the trim to FEED_DAYS happens here, against local
 * midnights, which is the only place that can know where they fall.
 */
export function groupRuns(data: ActivityResponse, now: Date = new Date()): Day[] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const oldest = new Date(midnight);
  oldest.setDate(oldest.getDate() - (FEED_DAYS - 1));
  const oldestMs = oldest.getTime();

  // keyed 'YYYY-MM-DD|block|userId' — the row's identity
  const runs = new Map<string, Run>();
  const days = new Map<string, Day>();

  for (const e of data.events) {
    const when = new Date(e.at * 1000);
    if (when.getTime() < oldestMs) continue;
    const player = data.players[String(e.userId)];
    if (!player) continue;

    const dateKey = localDateKey(when);
    const block = timeGreeting(when.getHours());
    const key = `${dateKey}|${block}|${e.userId}`;

    if (!days.has(dateKey)) {
      const [yr, mo, dy] = dateKey.split('-').map(Number);
      days.set(dateKey, { dateKey, startsAt: new Date(yr, mo - 1, dy).getTime() / 1000, runs: [] });
    }
    let run = runs.get(key);
    if (!run) {
      run = {
        userId: e.userId,
        handle: player.handle,
        block,
        at: e.at,
        boards: 0,
        eloDelta: null,
        crossings: [],
        milestones: [],
        joined: false,
      };
      runs.set(key, run);
      days.get(dateKey)!.runs.push(run);
    }
    run.at = Math.max(run.at, e.at);

    if (e.kind === 'board') run.boards += 1;
    else if (e.kind === 'joined') run.joined = true;
    else if (e.kind === 'milestone') run.milestones.push(e);
    else {
      run.crossings.push(e);
      // null + null stays null (nothing rated); null + n becomes n. Summing
      // through a null as if it were 0 would print "+0" for an unrated
      // crossing, which is a different claim from "this didn't rate".
      if (e.eloDelta !== null) run.eloDelta = (run.eloDelta ?? 0) + e.eloDelta;
    }
  }

  // Fill in the days nobody played. A gap in the week is information — dropping
  // them would make the bridge look busier than it is.
  for (let i = 0; i < FEED_DAYS; i++) {
    const d = new Date(midnight);
    d.setDate(d.getDate() - i);
    const key = localDateKey(d);
    if (!days.has(key)) days.set(key, { dateKey: key, startsAt: d.getTime() / 1000, runs: [] });
  }

  return [...days.values()]
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
    .map((d) => ({ ...d, runs: d.runs.sort((a, b) => b.at - a.at) }));
}

const MILESTONE_WORDS: Record<Extract<ActivityEvent, { kind: 'milestone' }>['milestone'], string> = {
  'first-crossing': 'first crossing finished',
  'entered-ladder': 'entered the ladder',
  'peak-rating': 'a new best rating',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Tournament #12" → "12", matching format.ts's tournamentNo. */
function crossingNo(c: Extract<ActivityEvent, { kind: 'crossing' }>): string {
  return c.tournamentName.match(/#(\d+)/)?.[1] ?? String(c.tournamentId);
}

/** "62%, 2nd of 5" — how a single crossing finished. */
function result(c: Extract<ActivityEvent, { kind: 'crossing' }>): string {
  return `${c.pct}%, ${ordinalLower(c.rank)} of ${c.of}`;
}

/**
 * Boards in a crossing. Mirrors the server's BOARDS_PER_TOURNAMENT (db.ts);
 * packages/core is deliberately not a web dependency, so the handful of
 * constants the client needs are mirrored rather than imported.
 */
const BOARDS_PER_CROSSING = 4;

/**
 * Boards this run played that its finished crossings don't account for — a
 * tournament started and left unfinished in that part of the day.
 *
 * Goes negative in the opposite, equally normal case: someone who finishes a
 * crossing on the first board of a session has one board and one crossing, and
 * nothing needs saying about it. Only a positive remainder is worth a clause.
 */
function orphanBoards(run: Run): number {
  return run.boards - run.crossings.length * BOARDS_PER_CROSSING;
}

/**
 * The italic line under a name. Two or three clauses after the board count —
 * more than that and it stops being a sentence and starts being a table.
 */
export function runSentence(run: Run): string {
  if (run.joined && run.boards === 0) return 'paid the first toll — no boards yet';

  const boards = plural(run.boards, 'board');
  const milestone = run.milestones[0];
  // "6 boards · finished №41" can't both be true of one crossing, which is
  // exactly four boards. Name the remainder so every board is accounted for.
  const orphan = orphanBoards(run);
  // The   is load-bearing: at phone width this clause wraps, and a plain
  // space let the line break after the count, leaving "…3rd of 5 · 2" hanging
  // at the end of a line where it reads as a pair of numbers rather than the
  // start of a phrase.
  const rest = run.crossings.length > 0 && orphan > 0 ? ` · ${orphan}\u00a0into another` : '';

  if (milestone) {
    const word = MILESTONE_WORDS[milestone.milestone];
    if (milestone.milestone === 'peak-rating' && milestone.value !== undefined) {
      return `${boards} · ${word} — ${milestone.value}${rest}`;
    }
    // A milestone earned on a single crossing keeps that crossing's result:
    // "first crossing finished" alone throws away the more interesting half of
    // the sentence. With several crossings there's no one result to attach.
    return run.crossings.length === 1
      ? `${boards} · ${word} — ${result(run.crossings[0])}${rest}`
      : `${boards} · ${word}${rest}`;
  }
  if (run.crossings.length === 1) {
    const c = run.crossings[0];
    return `${boards} · finished №${crossingNo(c)} — ${result(c)}${rest}`;
  }
  if (run.crossings.length > 1) {
    const best = Math.max(...run.crossings.map((c) => c.pct));
    return `${boards} · ${plural(run.crossings.length, 'crossing')}, best ${best}%${rest}`;
  }
  return `${boards} · nothing finished yet`;
}

/** 2 → "2nd". Lowercase, because this one sits inside a sentence. */
function ordinalLower(n: number): string {
  const r100 = n % 100;
  const r10 = n % 10;
  const suffix = r100 >= 11 && r100 <= 13 ? 'th' : r10 === 1 ? 'st' : r10 === 2 ? 'nd' : r10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** One tick on a day strip. */
export interface Mark {
  /** 0–1 across the day, midnight to midnight */
  x: number;
  /** 0–1 of the strip's full mark height */
  height: number;
  /** a join has no boards behind it and is drawn quiet */
  kind: 'run' | 'join';
}

/**
 * Boards at which a mark reaches full height. Fixed rather than per-day, so
 * that a busy Saturday actually looks busier than a quiet Tuesday instead of
 * every day being normalised to look the same.
 */
export const MARK_FULL_BOARDS = 12;

export function stripMarks(day: Day): Mark[] {
  return day.runs.map((run) => {
    const x = Math.min(1, Math.max(0, (run.at - day.startsAt) / 86400));
    if (run.boards === 0) return { x, height: 0.25, kind: 'join' as const };
    // A floor, so a single-board run is still visibly a mark and not a speck.
    return { x, height: Math.max(0.3, Math.min(1, run.boards / MARK_FULL_BOARDS)), kind: 'run' as const };
  });
}

/** Plain-language summary of a day, for the strip's screen-reader label. */
export function stripLabel(day: Day, label: string): string {
  if (!day.runs.length) return `${label}: nobody crossed.`;
  const players = new Set(day.runs.map((r) => r.userId)).size;
  const boards = day.runs.reduce((n, r) => n + r.boards, 0);
  return `${label}: ${plural(players, 'player')}, ${plural(boards, 'board')}.`;
}
