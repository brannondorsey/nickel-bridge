import { useEffect, useState } from 'react';
import type { PendingQuiz } from '../../api';
import { GlossaryProse } from './GlossaryProse';

/**
 * The Pop-Up Quiz interrupt — a centered ticket card over a dimmed table,
 * with a minimize dock as the only "step away" affordance. Modeled on
 * ClaimOverlay.tsx's shape (scrim, role="dialog") but deliberately does NOT
 * let Escape or a scrim tap dismiss it — the brief's "no skip": every
 * triggered quiz requires an answer before play resumes.
 *
 * Stays mounted the whole time a quiz is pending (Board.tsx renders it once,
 * keyed by nothing) so minimizing never loses in-progress multi-select taps
 * — `quiz.id` changing is the only reset signal, which only happens for a
 * genuinely new question, never for a minimize/resume round trip on the same
 * one.
 */
export function PopUpQuiz({
  quiz,
  onAnswer,
  acking,
}: {
  quiz: PendingQuiz;
  /** submits the answer — Board.tsx owns the request + resume beat */
  onAnswer: (answer: number[]) => void;
  /** true from the moment a single-choice tap (or multi-select CONFIRM)
   *  fires until the resumed board actually lands — renders the
   *  acknowledgment state optimistically */
  acking: boolean;
}) {
  const [minimized, setMinimized] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [ackedAnswer, setAckedAnswer] = useState<number[] | null>(null);

  useEffect(() => {
    setMinimized(false);
    setSelected([]);
    setAckedAnswer(null);
  }, [quiz.id]);

  const submit = (answer: number[]) => {
    setAckedAnswer(answer);
    onAnswer(answer);
  };

  const toggleOption = (i: number) => {
    setSelected((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]));
  };

  if (minimized) {
    return (
      <div
        className="resume-dock"
        role="button"
        tabIndex={0}
        aria-label="Pop Quiz minimized — resume"
        onClick={() => setMinimized(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setMinimized(false);
        }}
      >
        <div className="qz-grip" aria-hidden="true" />
        <div className="resume-row">
          <span className="resume-label">POP QUIZ · MINIMIZED</span>
          <span className="resume-cta">RESUME →</span>
        </div>
      </div>
    );
  }

  const showingAck = acking || ackedAnswer !== null;

  return (
    <div className="qz-overlay" role="dialog" aria-modal="true" aria-label="Pop Quiz">
      <div className={`qz-card${showingAck ? ' qz-ack' : ''}`}>
        <div className="qz-card-head">
          <span className="qz-chip">POP QUIZ</span>
          <button type="button" className="qz-min-btn" aria-label="Minimize" onClick={() => setMinimized(true)}>
            −
          </button>
        </div>
        {!showingAck ? <p className="qz-subtitle">Practicing Card Counting.</p> : null}
        <p className="qz-q">
          <GlossaryProse text={quiz.prompt} />
        </p>
        <div className="qz-opts">
          {quiz.options.map((opt, i) => {
            const isAnswer = ackedAnswer?.includes(i) ?? false;
            if (quiz.multiSelect) {
              const checked = showingAck ? isAnswer : selected.includes(i);
              return (
                <div
                  key={i}
                  className={`qz-check${showingAck ? ' qz-check-locked' : ''}`}
                  role={showingAck ? undefined : 'checkbox'}
                  aria-checked={showingAck ? undefined : checked}
                  aria-disabled={showingAck ? true : undefined}
                  tabIndex={showingAck ? undefined : 0}
                  onClick={showingAck ? undefined : () => toggleOption(i)}
                  onKeyDown={
                    showingAck
                      ? undefined
                      : (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleOption(i);
                          }
                        }
                  }
                >
                  <span className={`qz-box${checked ? ' on' : ''}`}>{checked ? '✓' : ''}</span>
                  {opt}
                </div>
              );
            }
            return (
              <button
                key={i}
                type="button"
                className={`qz-opt${showingAck && isAnswer ? ' selected' : ''}`}
                disabled={showingAck}
                onClick={() => submit([i])}
              >
                {opt} <span className="glyph">{showingAck && isAnswer ? '●' : '◯'}</span>
              </button>
            );
          })}
        </div>
        {quiz.multiSelect && !showingAck ? (
          <div className="qz-confirmbar">
            <button
              type="button"
              className="qz-btn"
              disabled={selected.length === 0}
              onClick={() => submit(selected)}
            >
              CONFIRM →
            </button>
          </div>
        ) : null}
        {showingAck ? <p className="qz-acktext">LOGGED — PLAY RESUMES</p> : null}
      </div>
    </div>
  );
}
