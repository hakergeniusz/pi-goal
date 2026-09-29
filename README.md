# pi-goal

An agent that says "done" is not done until a verifier agrees.

Arm a goal with `/goal <text>`. From then on, every time the agent finishes a
run, a verifier model call receives the goal plus a trimmed transcript digest
and rules on the evidence: **DONE** (settle normally — the claim survived an
audit), **NOT_DONE** (the run is continued with the verifier's reason injected,
so the next turn starts from what is actually missing), or **UNREACHABLE**
(goal cleared with the blocker reported).

## The seam

This is Claude Code's stop-hook pattern on pi's `agent_before_settle` boundary
(see `src/query/stopHooks.ts` in the Claude Code source: a blocking stop hook
becomes an injected message and the query loop continues). pi exposes the same
shape: the settle handler may append a `custom_message` entry and set
`continue = true` to request exactly one more run.

## The loop, and its guards

- **No-progress detector**: the same normalized blocker on two consecutive
  checks clears the goal with that blocker reported — a verifier must be able
  to end the treadmill, not just push it.
- **Check ceiling**: after `PI_GOAL_MAX_CHECKS` (default 12) checks the goal is
  cleared and reported. `/goal <text>` re-arms.
- **Fail-open**: if the verifier call fails, the run settles normally and the
  goal stays armed; three consecutive failures pause the goal (re-arm with
  `/goal <text>`). A broken verifier must never trap a finished run.
- **Aborts are respected**: only clean `completed` outcomes are audited, and
  pi's own `canContinue` guard always wins.

The continuation message is visible in the transcript, so you always see *why*
the agent kept going. The verifier is a nested `streamSimple` call with
reasoning off — deliberately cheap, since it runs after every settle while a
goal is armed.

## Install

```bash
pi install /path/to/pi-goal
# or, once pushed:
pi install git:github.com/hakergeniusz/pi-goal
```

## Commands

```
/goal <text>   arm a goal
/goal          show the current goal and check counter
/goal clear    dismiss the goal
```

A `goal` status-line entry tracks the armed goal and check budget.

## Configuration

| Variable                  | Default | Meaning                                      |
| ------------------------- | ------- | -------------------------------------------- |
| `PI_GOAL_MAX_CHECKS`      | `12`    | Continuations per goal before giving up      |
| `PI_GOAL_CHECK_MODEL`     | active model | `provider/id` for a cheaper verifier    |
| `PI_GOAL_OFF`             | *(off)* | `1` disables all checking                    |

## Verify

```bash
bun test.ts        # 23 assertions, canned verdicts, no network
bun x tsc --noEmit # strict, against the real 0.87.1 types
```

MIT licensed.
