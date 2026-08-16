import { beforeAll, describe, expect, it } from 'vitest';
import { freshDbEnv } from './helpers.js';

freshDbEnv('quiz');

const { db } = await import('../src/db.js');
const game = await import('../src/game.js');
const quiz = await import('../src/quiz.js');

let userId = 0;
beforeAll(() => {
  userId = (
    db.prepare(`INSERT INTO users (google_id, name, handle, handle_key) VALUES ('dev:qtester','Q','Q','q') RETURNING id`).get() as {
      id: number;
    }
  ).id;
});

function setQuizFrequency(freq: 'never' | 'sometimes' | 'often') {
  db.prepare(`UPDATE users SET quiz_frequency = ? WHERE id = ?`).run(freq, userId);
}

function makeTournament(seed: string) {
  return db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('t', ?) RETURNING *`).get(seed) as any;
}

function pendingRows(boardId: number) {
  return db.prepare(`SELECT * FROM pop_quizzes WHERE board_id = ?`).all(boardId) as any[];
}

/** Drive to completion through game.ts directly (no HTTP), answering any
 *  pending quiz with option index 0 (or every option, for multi-select). */
async function driveBoard(t: any, b: any): Promise<any[]> {
  const views: any[] = [];
  let view = game.boardView(t, b, 1200);
  views.push(view);
  let safety = 300;
  while (view.state !== 'done' && safety-- > 0) {
    if (view.state === 'playing' && (view as any).quiz) {
      const q = (view as any).quiz;
      await game.submitQuizAnswer(b, q.id, [0]);
    } else if (view.state === 'bidding' && view.myTurn) {
      await game.submitCall(b, 0);
    } else if (view.state === 'playing' && view.myTurn) {
      await game.submitPlay(b, (view.legalCards as number[])[0]);
    } else {
      throw new Error(`stuck: ${view.state} myTurn=${view.myTurn}`);
    }
    view = game.boardView(t, b, 1200);
    views.push(view);
  }
  if (view.state !== 'done') throw new Error('board did not finish');
  return views;
}

describe('Pop-Up Quiz — quiz_frequency: never', () => {
  it('never generates a quiz row, ever', async () => {
    setQuizFrequency('never');
    const t = makeTournament('quiz-off-1');
    const b = game.loadBoard(t, userId, 1, true)!;
    await game.ensureAdvanced(b);
    const views = await driveBoard(t, b);
    expect(views.some((v) => v.quiz)).toBe(false);
    expect(pendingRows(b.row.id).length).toBe(0);
  });
});

describe('Pop-Up Quiz — quiz_frequency: often', () => {
  it('fires at least one quiz over several boards, and redacts correctAnswer/reasoning on the live view', async () => {
    setQuizFrequency('often');
    let sawQuiz = false;
    for (let n = 1; n <= 6 && !sawQuiz; n++) {
      const t = makeTournament(`quiz-on-${n}`);
      const b = game.loadBoard(t, userId, 1, true)!;
      await game.ensureAdvanced(b);
      let view = game.boardView(t, b, 1200);
      while (view.state !== 'done') {
        if (view.state === 'playing' && (view as any).quiz) {
          sawQuiz = true;
          const q = (view as any).quiz;
          expect(q).not.toHaveProperty('correctAnswer');
          expect(q).not.toHaveProperty('reasoning');
          expect(view.myTurn).toBe(false);
          expect(view.legalCards).toBeUndefined();
          await game.submitQuizAnswer(b, q.id, [0]);
        } else if (view.state === 'bidding' && view.myTurn) {
          await game.submitCall(b, 0);
        } else if (view.state === 'playing' && view.myTurn) {
          await game.submitPlay(b, (view.legalCards as number[])[0]);
        } else {
          break;
        }
        view = game.boardView(t, b, 1200);
      }
    }
    expect(sawQuiz).toBe(true);
  });

  it('the cross-call gate freezes the board across an intervening ensureAdvanced call', async () => {
    setQuizFrequency('often');
    let t: any, b: any, view: any;
    for (let n = 1; n <= 10; n++) {
      t = makeTournament(`quiz-freeze-${n}`);
      b = game.loadBoard(t, userId, 1, true)!;
      await game.ensureAdvanced(b);
      view = game.boardView(t, b, 1200);
      while (view.state !== 'done' && !(view.state === 'playing' && view.quiz)) {
        if (view.state === 'bidding' && view.myTurn) await game.submitCall(b, 0);
        else if (view.state === 'playing' && view.myTurn) await game.submitPlay(b, view.legalCards[0]);
        else break;
        view = game.boardView(t, b, 1200);
      }
      if (view.state === 'playing' && view.quiz) break;
    }
    expect(view.state).toBe('playing');
    expect(view.quiz).toBeTruthy();

    const before = { calls: [...b.calls], plays: [...b.plays], state: b.row.state, updatedAt: b.row.updated_at };
    // simulate a reload / second tab: a plain GET-equivalent, with nothing answered
    await game.ensureAdvanced(b);
    await game.ensureAdvanced(b);
    expect(b.calls).toEqual(before.calls);
    expect(b.plays).toEqual(before.plays);
    expect(b.row.state).toBe(before.state);
    // save() only runs when something actually changed — updated_at proves ensureAdvanced no-opped
    expect(b.row.updated_at).toBe(before.updatedAt);

    // submitPlay is rejected outright while the quiz sits unanswered
    await expect(game.submitPlay(b, view.legalCards ?? 0)).rejects.toThrow();

    // answering resumes play in the same call — the board genuinely advances
    const q = view.quiz;
    await game.submitQuizAnswer(b, q.id, [0]);
    const after = game.boardView(t, b, 1200);
    expect(JSON.stringify(after) === JSON.stringify(view)).toBe(false);

    // answering the same quiz again is rejected, not silently re-scored
    await expect(game.submitQuizAnswer(b, q.id, [0])).rejects.toThrow();
  });
});

describe('Pop-Up Quiz — invariants over many played-out boards', () => {
  it('a finished board never carries a pending quiz, and no quiz row falls inside a claimed tail', async () => {
    setQuizFrequency('often');
    for (let n = 1; n <= 12; n++) {
      const t = makeTournament(`quiz-invariant-${n}`);
      const b = game.loadBoard(t, userId, 1, true)!;
      await game.ensureAdvanced(b);
      await driveBoard(t, b);
      expect(quiz.hasPendingQuiz(b.row.id)).toBe(false);
      const rows = pendingRows(b.row.id);
      for (const r of rows) {
        expect(r.answer).not.toBeNull();
        if (b.row.claimed_at_ply !== null) expect(r.ply).toBeLessThanOrEqual(b.row.claimed_at_ply);
      }
    }
  });

  it('quizReportCard/quizAnalyzeReveal are null until the board is done, then populated', async () => {
    setQuizFrequency('often');
    let t: any, b: any;
    for (let n = 1; n <= 6; n++) {
      t = makeTournament(`quiz-report-${n}`);
      b = game.loadBoard(t, userId, 1, true)!;
      await game.ensureAdvanced(b);
      expect(quiz.quizReportCard(b.row.id)).toBeNull();
      await driveBoard(t, b);
      if (quiz.quizReportCard(b.row.id)) break;
    }
    const report = quiz.quizReportCard(b.row.id);
    const reveal = quiz.quizAnalyzeReveal(b.row.id);
    if (report) {
      expect(report.length).toBeGreaterThan(0);
      expect(reveal!.length).toBe(report.length);
      for (const row of reveal!) {
        // reasoning is present only on a miss
        if (row.correct) expect(row.reasoning).toBeNull();
      }
    }
  });
});
