---
name: player-outreach
description: >
  Generate the Nickel Bridge player roster from the production database and draft the weekly
  player-outreach emails — asking churned players what went wrong, retained players what's
  working, and first-board casualties what stopped them. Use this
  skill whenever the user asks about Nickel Bridge players, users, signups, retention, churn,
  cohorts, "who's playing", player emails or a player CSV, or wants to email/contact/survey
  players or "do the weekly outreach" — even if they don't name this skill or mention email.
  Also use it for any read-only question about the live production database (how many players,
  who's on the leaderboard, how many boards someone has played), since it owns the only safe
  path to that data.
---

# Nickel Bridge player outreach

Nickel Bridge has no analytics stack and no admin API. The only record of who plays is the
SQLite file on the single production Fly machine. This skill owns the one safe path to it and
turns it into a weekly ritual: find the people who just arrived, ask the churned ones what went
wrong and the sticky ones what's working, and learn whether the URL is holding the thing back.

The goal of the emails is **replies, not impressions**. Everything below is in service of that.

## What you need

- `FLY_API_TOKEN` in the environment (Claude Code's remote environment for this repo has it; a
  normal local checkout does not — this is why the user asked for a script only you can run).
- The Gmail connector, for drafting. It can create drafts but **cannot send** them, which is the
  correct shape: a human reads every word before it reaches a real person.

## Step 1 — Pull the roster

```bash
node .claude/skills/player-outreach/scripts/player_report.mjs \
  --json "$SCRATCH/report.json" --csv "$SCRATCH/roster.csv"
```

`$SCRATCH` is the session scratchpad directory named in your system prompt — an absolute path
outside the repo. **Never write these outputs into the repo** — it is public, and
these files are real people's names and email addresses. Never put roster data in an Artifact or
any other shareable surface. If the user wants the CSV, hand it over with `SendUserFile`.

The script execs a read-only SQLite query on the production machine and prints a summary. See
`references/data-model.md` if you need to change the query or explain a number — in particular
before you trust "boards played" as a measure of anything, because the leaderboard does not.

## Step 2 — Work out who is actually new

The point of the weekly cadence is to reach people **once**, shortly after they arrive. Emailing
someone a second time with the same question is the fastest way to turn a friendly solo-dev note
into spam.

There is deliberately **no contact ledger in this repo** — it's public, so it can't hold player
data. Gmail's sent mail is the source of truth, and it has the advantage of recording what was
actually *sent* rather than what was merely drafted:

```
search_threads: in:sent subject:"nickel bridge"
```

Collect every recipient address from those threads, plus anything already sitting in
`list_drafts`, and subtract that set from the roster. Whoever remains is this week's batch.

This is why **every subject line must contain the words "Nickel Bridge"** — rewrite subjects
however you like otherwise, but that phrase is load-bearing. It's what makes next week's run
able to see this week's, and a clever subject that drops it quietly re-enrolls that person in
the next batch.

If that search returns nothing on a first run, say so plainly rather than assuming — an empty
result and a broken query look identical, and the cost of guessing wrong is double-emailing
everyone.

## Step 3 — Choose who gets written to

The script assigns each player a cohort. Two get email:

| Cohort | Rule | The question |
| --- | --- | --- |
| `friction` | Finished 1–15 boards, all on a single day, never returned — and quiet for at least `--cooldown-days` (default 3) | Why did you stop? |
| `retained` | 16+ boards, **or** played on 2+ separate days, **or** on the leaderboard | What's keeping you here? |
| `abandoned_first` | Never finished a single board, but opened one and walked away mid-board | Would you be willing to say what you hit? |

`retained` is tested first, because the two definitions overlap — someone with 5 boards across 3
days matches both. Coming back on a second day is the stronger statement about their experience,
so it wins, which leaves `friction` as the clean complement: tried it once and never returned.

`never_played` — signed up and never so much as opened a board — gets **no email**. They have no
experience of the game to report on, and "why did you stop?" to someone who never started reads
as a misfire. Report the count; it's a marketing-channel question, not a product one.

`abandoned_first` is carved out of that group and is the one worth the most care. These people
were dealt a hand and left mid-board, which makes them the sharpest signal on the roster: they
saw the actual product and it lost them within minutes. The script says exactly where, from the
board's own `calls`/`plays`:

- `stopped_at` — `auction` (never played a card) or `play` (cards were on the table).
- `human_calls` — how many bids *they* made. **Zero is the finding**: they reached their first
  decision and made none.

Name that in the email. "You didn't get far into the bidding" proves a human looked at their
account rather than adding them to a list, and it's the whole reason this cohort replies at all.
Check `stopped_at` before writing the clause — telling someone they left during the bidding when
they actually played eleven cards destroys exactly the credibility the specificity was buying.

Players the script marks `too_recent` are also held. The friction email asserts something about
its reader — that they left — and saying that to someone who played yesterday is both wrong and
faintly insulting: they haven't churned, they just haven't played *today*. They aren't dropped,
only deferred, and by the next run they've either come back (landing in `retained`) or genuinely
gone quiet. Report how many were held; if the user wants them anyway, re-run with
`--cooldown-days 0`.

Before drafting, scan the batch by eye for rows that shouldn't be written to at all: obvious
throwaway or role addresses, junk display names, anything that looks like a test account. The
script already excludes the operator's own account (Brannon is the top player by board count and
would otherwise get a "what's keeping you playing?" email every single week). Raise anything else
you're unsure about with the user instead of quietly drafting or quietly skipping.

## Step 4 — Draft the emails

One draft per player via `create_draft`. Plain text (`body`, not `htmlBody`) — plain text from a
person outperforms formatted mail from a brand at getting replies, and there's nothing here worth
formatting.

**Do not apply the `nickel-bridge-design` skill to these emails.** That skill governs the app's
1920s toll-bridge identity, and it's right for the product. In an unsolicited email it inverts:
period-costume prose from an unfamiliar sender reads as marketing, and marketing gets archived.
The voice here is one person who built a thing writing to one person who tried it.

What makes these work:

- **Short.** Four or five sentences. Every extra line lowers the reply rate.
- **Specific, from real data.** The numbers exist to prove a human looked at their account, so
  lead with whatever is genuinely striking about *this* player rather than filling in a blank.
  85 boards in a single day is a different email from 18 boards across 3 weeks; one board and
  gone is different again. If a player's row has nothing striking, plain and honest beats
  manufactured enthusiasm.
- **One question.** Plus the domain question in the `friction` and `retained` mails, where it's
  small enough to ride along. It stays out of `abandoned_first` — see that template.
- **A cheap out.** "One line is plenty" gets more replies than an open-ended ask.
- **No tracking, no images, no unsubscribe boilerplate.** It's a personal email, so let it be one.

### Asking the domain question without poisoning it

The user wants to know whether a dedicated domain (default: **nickelbridge.com** — confirm the
exact spelling with them before drafting, it's been written as "nickebridge.com") would beat
`bridge.brannon.online` for discoverability or retention.

Phrase it so a "no" is as easy to give as a "yes". "Would a real domain help?" invites everyone
to agree agreeably and produces worthless data; ending with **"or does the address not matter to
you?"** gives explicit permission to dismiss it, and the dismissals are the useful signal here.
Ask about their actual behaviour — remembering it, typing it, sending it to someone — not their
opinion of domains in the abstract.

### Templates

Starting points, not forms to fill. Rewrite freely so each one sounds like it was typed for that
person; the greeting uses their first name from `name`, falling back to their handle, or "Hi
there" if both look like junk.

**`friction`** — subject: `a question about Nickel Bridge`

```
Hi {first},

I'm Brannon — I built Nickel Bridge, the duplicate bridge site you tried on {date}.
You played {n} boards and then didn't come back, and I'd really like to know why.

There's no wrong answer: too confusing, too slow, awkward on your phone, robots too
strong, or just not your thing. Whatever made you close the tab is the most useful
thing you could tell me.

One other thing I'm weighing: it currently lives at bridge.brannon.online. Would a
real domain like nickelbridge.com have made any difference — easier to remember or
to trust — or does the address not matter to you?

Just hit reply, one line is plenty.

— Brannon
```

**`retained`** — subject: `Nickel Bridge — what's making it stick?`

```
Hi {first},

Brannon here — I built Nickel Bridge. You've played {n} boards {when}, which puts
you in a very small group of people who've really used it. Thank you, sincerely.

I'd love to know what keeps you coming back — the duplicate scoring, the bid
grading, beating the house robots, something I'd never guess? And the other half of
that: what's the most annoying part you've put up with?

Also a small one: it lives at bridge.brannon.online today. If you wanted to tell a
bridge-playing friend about it, would a real domain like nickelbridge.com make that
easier — or is the address irrelevant?

Whatever you've got, even one line.

— Brannon
```

**`abandoned_first`** — subject: `Nickel Bridge — can I ask you something?`

```
Hi {first},

I'm Brannon — I made Nickel Bridge. You tried it on the 23rd and didn't
get far into the bidding before you left, which I'd bet is my fault
rather than yours.

Would you be up for telling me what you hit? A sentence is plenty.
You've seen it with completely fresh eyes, which I can't do anymore,
and that makes your take more useful to me than almost anything else.

Totally fine to ignore this.

— Brannon
```

For `stopped_at: 'play'`, swap the first clause to "got a few cards into the hand before you
left" and leave the rest.

This one is deliberately built differently from the other two, and the differences are the
point. **The ask is permission, not a questionnaire** — "would you be up for telling me?" opens
a conversation, where a list of options to pick from makes a stranger feel processed, which is
fatal for people who owe you nothing and gave you ninety seconds. **The fault is claimed
up front**, because the reason people don't answer "what went wrong?" is that they suspect the
answer is that they were too slow to understand it; saying it's your fault first removes that.
**And there's no domain question** — asking someone who never completed a bid whether a
different URL would have helped is absurd, since finding the site plainly wasn't their problem.
Keep it to five lines. The brevity is doing work: it signals that a reply can be short too.

You cannot send, and shouldn't want to. Report back with a table of who's in each cohort and
why, the counts including the `never_played` group, anything you skipped and your reason, and a
note that the drafts are in Gmail awaiting review.

Two things are worth calling out in that report even though they generate no email, because
they're the sharpest signals in the data and they're invisible if you only count cohorts:
players whose `boards_started` exceeds `boards_done` **abandoned a hand mid-play**, which is a
much more specific failure than "signed up and never played"; and the ratio of players who ever
returned on a second day is the number the retained cohort is really made of. Report the funnel,
not just the batch.

Tell the user plainly that nothing has been sent. If they later ask you to "send them", say that
the connector only drafts — they send from Gmail.

## When the cohorts drift

Cohorts are computed fresh each run, so someone emailed months ago as `friction` may show up as
`retained` later. That's a genuinely interesting person — they came back after bouncing — but
it's also a second cold email to someone who may never have answered the first. Surface them to
the user as a judgment call with the history attached; don't auto-draft.

## Reference

- `references/data-model.md` — the schema behind the query, why "16 boards" and "on the
  leaderboard" are different tests, and how to safely change the SQL.
