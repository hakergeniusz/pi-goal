# pi-goal

An agent that says "done" is not done until a verifier agrees.

Arm a goal with `/goal <text>`. Arming starts a turn immediately with the
condition as the directive. After every turn, a verifier model receives the
goal plus a trimmed transcript digest and rules on the evidence:
**DONE** (an achieved entry is recorded, the goal clears),
**NOT_DONE** (the next turn starts with the verifier's reason as guidance),
or **UNREACHABLE** (a failed entry is recorded, the goal clears).

## The seam

This mirrors Claude Code's `/goal` (see `Keep Claude working toward a goal`
in the Claude Code docs: the goal is a session-scoped prompt-based Stop hook;
after each turn a small fast model returns met / not-met / impossible).
pi exposes the same shape on two boundaries: `turn_end` (primary — evaluate
after every turn) and `agent_before_settle` (backstop — only fires when a
turn went unevaluated, so an evaluated turn is never double-checked).

## The loop, and its guards

- **Stall detector**: no tool use for `PI_GOAL_STALL_TURNS` (default 3)
  consecutive turns pauses the loop but KEEPS the goal; the next prompt
  resumes evaluation. Chatting is not progress.
- **Check ceiling**: after `PI_GOAL_MAX_CHECKS` (default 12) evaluations the
  goal is cleared and reported. `/goal <text>` re-arms.
- **Fail-open**: if the verifier call fails, the turn settles normally and
  the goal stays armed; three consecutive failures pause the goal. A broken
  verifier must never trap a finished run.
- **Error turns pause, aborts are respected**: only clean `completed`
  outcomes are audited; an `error` outcome keeps the goal armed for the next
  message, and pi's own `canContinue` guard always wins.
- **Background work defers evaluation**: while messages are pending, the
  check waits for a later turn instead of judging an incomplete state.
- **Resume restores**: goal state persists in session `pi-goal` custom
  entries, so resuming a session restores an armed goal with fresh counters.
  Cleared and achieved goals stay cleared.

Every verdict lands in the transcript as a visible `pi-goal` entry, so you
always see *why* the agent kept going. The verifier is a nested
`streamSimple` call with minimal reasoning — deliberately cheap, since it
runs after every turn while a goal is armed.

## Install

```bash
pi install /path/to/pi-goal
# or, once pushed:
pi install git:github.com/hakergeniusz/pi-goal
```

## Commands

```
/goal <text>   arm a goal (replaces any active goal, starts a turn)
/goal          show condition, elapsed, turns, checks, tokens, last reason
/goal clear    dismiss the goal (aliases: stop off reset none cancel)
```

A `goal` status indicator tracks the armed goal. Conditions are capped at
4000 chars; include a turn/time clause to bound the run.

## Configuration

| Variable                  | Default | Meaning                                      |
| ------------------------- | ------- | -------------------------------------------- |
| `PI_GOAL_MAX_CHECKS`      | `12`    | Evaluations per goal before giving up        |
| `PI_GOAL_STALL_TURNS`     | `3`     | Idle turns before pausing (goal kept)        |
| `PI_GOAL_CHECK_MODEL`     | active model | `provider:id` or bare id for a cheaper verifier |
| `PI_GOAL_OFF`             | *(off)* | `1` disables all checking                    |

## Verify

```bash
bun test.ts        # spec tests, canned verdicts, no network
bun x tsc --noEmit # strict, against the real extension types
```

MIT licensed.
