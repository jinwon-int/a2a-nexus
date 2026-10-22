# Skills intake replay — `skills.skill-intake-replay.v1` (spec, slice 1)

The effect-validation gate of the intake pipeline (jinwon-int/ccc-node#2463,
epic #2462 G1). Today a candidate is promoted on an independent review
`approve` alone. External systems that evolve skills unattended keep a
*validation gate* — a change is kept only when a replayed task scores at least
as well with the skill as without it (microsoft/SkillOpt-Sleep: ungated nightly
evolution collapsed 0.554 → 0.026 in five nights; gated held or improved).
This document specifies the packet and result shape for that gate in our
fleet. **Status: slice 1 = schema + procedure only. No worker handler exists
yet; the publisher records replay plans (`a2a-replay-plan`) under
`skill-promotion.replay-gate = dry-run` and promotes exactly as before.**

## Flow (target shape)

```
intake PR approved (independent review)
  -> publisher classifies the candidate: script-bearing | narrative
  -> replay-gate = off     : promote as today (default)
  -> replay-gate = dry-run : record a2a-replay-plan, promote as today   <- slice 1
  -> replay-gate = true    : one skills_intake_replay task to the AUTHOR node
       -> worker mines 1..3 task records from the originating session
       -> replays each task without / with the candidate skill
       -> returns per-task checks (machine or independent judge) + scores
  -> publisher: with >= without  -> promotable (score noted in the promote body)
                with <  without  -> revise findings (one round), then re-gate
                not-replayable   -> promotable, flagged "unvalidated"
```

The gate never *rejects* a candidate; it only converts a regression into one
revise round with concrete findings. Everything else in the pipeline (machine
gates, review rubric, arbitration, identity generalization) is unchanged.

## Eligibility (publisher side)

| Class | Rule | Replay |
|---|---|---|
| `script-bearing` | the tree has `scripts/`, `tests/` or `*.test.sh` | machine check: the bundled test/script exit code (and a task-record check command when mined) |
| `narrative` | `SKILL.md` (+ `references/`, `templates/`) only | independent judge on another node, rubric `2026-10-22.1` areas C/E/H, never the author or reviewer of the lineage |

Measured 2026-10-22: 28 of 183 approved skills (15%) are script-bearing, so
slice 2 must implement the narrative path for the gate to matter.

## Session resolution (author node)

The intake envelope carries no session reference by design (it is the
reviewed tree only). The author node resolves the originating session by skill
name from its own draft store — `~/.claude/state/pending-skills/<draft>/meta.json`
whose directory name ends with `-<skillName>` (optionally suffixed
`.installed-<ts>`); `meta.json.session_id` names the local transcript
(`~/.claude/projects/<project>/<session_id>.jsonl`). Measured 2026-10-22: every
draft with `meta.json` on two sampled nodes carried `session_id` (98/98,
134/134). Codex-lane drafts use a different store (**to confirm in slice 2**).
A candidate whose session cannot be resolved returns `not-replayable`.

Transcripts never leave the author node: only mined task records (prompt text
after the fleet redaction rules, a check command, expected outcome) enter the
result, bounded by `maxTasks`.

## Packet schema — `skills.skill-intake-replay.v1`

Dispatch manifest `lanes[].payload`:

| Field | Type | Notes |
|---|---|---|
| `schema` | const `"skills.skill-intake-replay.v1"` | |
| `rubricVersion` | string | the review rubric for the judge path, e.g. `"2026-10-22.1"` |
| `scope` | string | `"fleet-internal"` (default) or `"public-elevation"` |
| `skillName` | string | candidate skill name (the draft-store lookup key) |
| `provenance` | object | `author_node`, `provider`, `intake_pr`, `branch`, `head_sha`, `source_tree_sha256`, `eligibility` (`script-bearing` / `narrative`) |
| `replayPolicy` | object | `maxTasks` (default 3), `rolloutsPerArm` (default 2), `arms` = `["without","with"]`, `judge` = `"machine"` / `"independent"`, `budgetTokens` (publisher-configured cap) |
| `skillFiles[]` | array | the candidate files as `{path, content}` — bounded as in the revise packet |
| `replayResultSchema` | object | the result shape below, embedded |
| `workerProcedure` | string | this document's worker-procedure section |

Manifest shape: `requester` is the publisher (`role: operator`); lane `target`
is the AUTHOR node for task mining and the `with`/`without` rollouts, with
`role: publisher`; `intent` is `skills_intake_replay`; task ids are unique per
gate round (`skills_intake_replay-pr<pr>-<author>-<timestamp>`). For
`narrative` candidates the judge step is a second lane to an independent node
(not the author, not the lineage's reviewer/reviser), carrying only the mined
task records and both arms' outputs.

## Worker procedure — `skills-intake-replayer` (draft)

1. Resolve the session as above; mine up to `maxTasks` task records: a user
   prompt that exercised the procedure, the observable outcome (file, command
   output, exit code), and a check command that re-verifies it. Skip records
   whose check needs credentials, network writes, or non-sandboxed state.
2. Replay each record `rolloutsPerArm` times per arm in a sandbox copy of the
   working tree: `without` (candidate skill absent) and `with` (candidate
   installed from `skillFiles[]`). Same model, same harness, same budget.
3. Score: `machine` = check command exit 0; `independent` = judge verdict on
   the rubric areas C/E/H with the SkillLens rule that the grader is never the
   generator. Emit per-task, per-arm pass counts.
4. Emit the result JSON only. Never modify the candidate, never push, never
   re-dispatch, never expose the edge secret or transcript bodies.

## Result schema

```jsonc
{
  "outcome": "replayed",                 // "replayed" | "not-replayable"
  "skillName": "<packet skillName>",
  "sourceTreeSha256": "<packet source_tree_sha256>",
  "eligibility": "script-bearing",       // echoed
  "tasks": [
    { "id": "t1", "check": "machine", "without": {"pass": 0, "runs": 2},
      "with": {"pass": 2, "runs": 2}, "note": "<redacted summary>" }
  ],
  "score": { "without": 0.0, "with": 1.0, "delta": 1.0 },
  "notReplayableReason": "<only when outcome=not-replayable>",
  "model": "<runtime model id>",
  "replayer_node": "<your node id>",
  "judge_node": "<independent node, narrative path only>"
}
```

A malformed result, or one whose `skillName`/`sourceTreeSha256` bindings do
not match the packet, is a handler failure (infrastructure classes retry once
on another node as every other round does); it is never a gate verdict.

## Gate rule (publisher)

- `score.with >= score.without` → promotable; the promote body shows
  `replay: with x/y vs without x/y`.
- `score.with < score.without` → one revise round with findings built from the
  failing task notes (area E, major); the revised tree is re-gated once.
- `not-replayable` → promotable, body flag `replay: unvalidated`.
- Ledger: `a2a-replay-plan` (eligibility, mode) at planning;
  `a2a-replay-dispatch` / `a2a-replay-result` mirror the revise rows.

## Cost discipline

Per candidate at most `maxTasks × rolloutsPerArm × 2` agent runs (default
12) on the author node plus one judge call for narrative candidates; the
publisher caps gate dispatches per cycle like arbitration (4). Rollout budget
is the publisher knob `CCC_SKILL_PROMOTION_REPLAY_BUDGET_TOKENS` (slice 2).

## Status

- Slice 1 (this document, ccc-node#2463): schema, eligibility, planning rows,
  `replay-gate` switch `off|dry-run` (`true` logs `replay_worker_not_deployed`).
- Slice 2: `skills-intake-replay-handler.sh` + intent routing on the worker,
  narrative judge lane, publisher dispatch/consume.
- Slice 3: gate enforcement in `_promotable` and the one-round revise loop.
