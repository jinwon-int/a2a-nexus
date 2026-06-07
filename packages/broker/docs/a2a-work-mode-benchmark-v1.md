# A2A Work Mode Benchmark v1

This source-only benchmark measures when a Team1 A2A round is better than a
solo Seoseo implementation path, and when the orchestration overhead is not
worth it.

The benchmark is a measurement runbook only. It must not dispatch live workers,
deploy, restart Gateway or broker services, mutate databases, ACK or replay
Terminal Brief rows, send provider or Telegram canaries, cancel live tasks, move
credentials, publish releases, or change repository visibility.

## Modes

| Mode | Definition | Normal owner |
|---|---|---|
| `solo` | One Seoseo implementation/review path from issue intake to PR/decision. | Seoseo |
| `team1` | Four evidence lanes (`sogyo`, `nosuk`, `yukson`, `bangtong`) plus one Seoseo finalizer. | Seoseo finalizer |
| `hybrid` | Seoseo implements or finalizes while Team1 supplies bounded evidence on risk, tests, or alternatives. | Seoseo finalizer |

Benchmark v1 compares `solo` and `team1`. `hybrid` is recorded when a run starts
as one mode but needs targeted helper evidence.

## Task Taxonomy

Each fixture is assigned exactly one primary task type.

| Type | Examples | Expected winner hypothesis |
|---|---|---|
| `small_patch` | One-file bug fix, narrow test update | `solo` |
| `bug_rca` | Root-cause trace plus regression test | mixed |
| `candidate_review` | Compare multiple PRs or worker proposals | `team1` |
| `ops_closeout` | Merge/close/Wiki/approval-boundary work without live deploy | mixed |
| `runbook_policy` | Policy, docs, acceptance matrix | `team1` or `hybrid` |

## Fairness Rules

Do not solve the same warmed problem twice. Use one of these approaches:

1. **Historical replay:** checkout the parent repository at the pre-fix commit,
   recreate the issue prompt, and run the selected mode in a temporary branch.
2. **Paired fixtures:** prepare two fixtures with the same type, expected file
   count, and risk profile. Randomly assign one to `solo` and one to `team1`.
3. **New work rotation:** for genuinely new issues, alternate assignment and
   compare only within the same task type over several samples.

If one mode has already seen the exact solution, mark the sample
`validity="contaminated"` and exclude it from headline speedup.

## Timeline Boundaries

Capture separate timestamps for these milestones:

| Milestone | Meaning |
|---|---|
| `instruction_received_at` | Operator request or issue selected. |
| `work_started_at` | Solo starts work, or Team1 dispatch completes. |
| `first_evidence_at` | First useful finding, PR, Done, or Block evidence. |
| `pr_opened_at` | Candidate PR opened, if any. |
| `ci_green_at` | Required checks pass. |
| `decision_at` | Finalizer decides merge, close, defer, or block. |
| `merged_at` | PR merged, if applicable. |
| `closeout_done_at` | Issue/PR/Wiki/final report complete. |

Use two headline durations:

- `decision_wall_seconds = decision_at - work_started_at`
- `closeout_wall_seconds = closeout_done_at - instruction_received_at`

This separates implementation/review speed from operational closeout cost.

## Metrics

| Metric | Formula or source | Why it matters |
|---|---|---|
| `solo_or_team_wall_seconds` | milestone deltas | Operator-visible latency. |
| `active_agent_seconds` | foreground agent/tool active time | Actual Seoseo effort. |
| `total_worker_seconds` | sum of Team1 lane durations | Total compute/work spent. |
| `speedup_ratio` | `solo_wall / team1_wall` | Parallel wall-clock gain. |
| `work_amplification_ratio` | `team1_total_worker / solo_active` | Cost of parallelism. |
| `merge_yield` | selected PRs / worker PRs | Useful output rate. |
| `rework_count` | extra commits, CI reruns, body edits, supersedes | Cleanup overhead. |
| `quality_findings_count` | real defects/risks caught before merge | Review value. |
| `followup_defect_count_7d` | linked follow-up bugs within seven days | Outcome quality. |
| `operator_interactions` | approvals, clarifications, interventions | Human load. |
| `telegram_messages` | status/final messages | Channel load. |

For Team1, record both `wall_seconds` and `total_worker_seconds`. A Team1 run can
be wall-clock faster while still using more total work.

## Result Record

Write one JSON object per benchmark sample. The companion schema lives at
`fixtures/work-mode-benchmark/result-record.schema.json`.

```json
{
  "benchmarkVersion": "a2a-work-mode-benchmark-v1",
  "sampleId": "a2a-broker-1280-solo-replay-001",
  "repo": "jinwon-int/a2a-broker",
  "issueNumber": 1280,
  "taskType": "bug_rca",
  "mode": "solo",
  "validity": "valid",
  "milestones": {
    "instructionReceivedAt": "2026-06-06T12:00:00Z",
    "workStartedAt": "2026-06-06T12:01:00Z",
    "decisionAt": "2026-06-06T12:20:00Z",
    "closeoutDoneAt": "2026-06-06T12:25:00Z"
  },
  "metrics": {
    "decisionWallSeconds": 1140,
    "closeoutWallSeconds": 1500,
    "activeAgentSeconds": 900,
    "totalWorkerSeconds": 900,
    "workerPrCount": 1,
    "selectedPrCount": 1,
    "reworkCount": 0,
    "qualityFindingsCount": 1,
    "followupDefectCount7d": 0,
    "operatorInteractions": 0,
    "telegramMessages": 4
  },
  "outcome": {
    "decision": "merged",
    "prUrl": "https://github.com/jinwon-int/a2a-broker/pull/1281",
    "mergeCommit": "6f61a6948455a88c953db1908920789e5ba8b2f1"
  },
  "notes": "Same-broker lane order progress regression."
}
```

## Result Table Template

Use `fixtures/work-mode-benchmark/results-template.csv` for spreadsheet-style
entry. Minimum columns:

| Column | Description |
|---|---|
| `sample_id` | Stable sample identifier. |
| `task_type` | One taxonomy value. |
| `mode` | `solo`, `team1`, or `hybrid`. |
| `validity` | `valid`, `paired`, `replay`, `contaminated`, or `excluded`. |
| `decision_wall_seconds` | Time to finalizer decision. |
| `closeout_wall_seconds` | Time to finished closeout. |
| `active_agent_seconds` | Seoseo active effort estimate. |
| `total_worker_seconds` | Sum of Team1 worker durations. |
| `speedup_pair_id` | Pair identifier for matched comparisons. |
| `work_amplification_ratio` | Cost ratio versus paired solo sample. |
| `rework_count` | CI reruns, body edits, supersede cleanup, extra commits. |
| `quality_findings_count` | Real risks/defects caught before merge. |
| `operator_interactions` | Human approvals or clarifications. |
| `telegram_messages` | User-visible status/final messages. |
| `decision` | `merged`, `closed`, `blocked`, `deferred`, or `docs_only`. |

## Candidate Fixture Pool

These recent issues are suitable for initial replay or paired-fixture design.
The list is a starting pool, not a mandate to reopen or replay live state.

| Candidate | Type | Why useful |
|---|---|---|
| `a2a-broker#1256` | `small_patch` | Propagate read-only/no-change flags into runner tasks. |
| `a2a-docker-runner#354` | `small_patch` | Runner no-change evidence contract; good cross-repo pair. |
| `a2a-broker#1254` | `runbook_policy` | Terminal outbox stale residue policy and docs. |
| `a2a-broker#1261` | `ops_closeout` | Superseded running task policy with finalizer cleanup. |
| `a2a-broker#1255` | `bug_rca` | Hot-table memory warning policy and diagnostics. |
| `a2a-broker#1253` | `candidate_review` | Multiple worker PRs plus finalizer synthesis. |
| `a2a-broker#1277` | `bug_rca` | Terminal Brief failed lanes counted as progress. |
| `a2a-broker#1280` | `bug_rca` | Lane order mistakenly used as same-broker progress. |
| `a2a-broker#1279` | `candidate_review` | Late PR hygiene and merge-as-supplement decision. |

For v1, pick eight samples: four `solo`, four `team1`, balanced across at
least three task types. Do not include live deploy samples in the first run.

## Analysis Output

After the sample set, produce:

1. Per-type median wall-clock and closeout time by mode.
2. Per-type work amplification by mode.
3. Quality notes: defects caught, missed approval boundaries, follow-up bugs.
4. Operator load notes: how much Telegram and human approval traffic each mode
   created.
5. Routing rules for future issues.

The 2026-06-06 analysis lives in
`docs/a2a-work-mode-benchmark-analysis-2026-06-06.md`. The derived operator
routing defaults live in `docs/a2a-work-mode-routing-rules.md`.

## Routing Rules Draft

Use the v1 measurements to refine these defaults:

| Work profile | Default mode |
|---|---|
| Narrow, well-understood source fix | `solo` |
| Ambiguous root cause with several plausible fixes | `team1` |
| Multiple worker PRs or conflicting recommendations | `team1` |
| Live deploy, rollback, DB, ACK/replay, or secret boundary | `solo` finalizer; Team1 evidence only if needed |
| Policy/runbook with several stakeholder perspectives | `team1` then Seoseo synthesis |
| Urgent operator-facing bug with known fix path | `solo` |

## Stop Conditions

Stop a benchmark sample and mark it `excluded` when:

- live deploy, Gateway restart, DB mutation, ACK/replay, or credential handling
  becomes necessary;
- the fixture cannot be reproduced from source state;
- a mode has already seen the exact solution;
- CI or GitHub outage dominates the result;
- the operator has to intervene enough that the sample no longer measures the
  mode.

## Related

- `docs/a2a-analysis-only-mode.md`
- `docs/a2a-work-mode-routing-rules.md`
- `docs/a2a-work-mode-benchmark-analysis-2026-06-06.md`
- `docs/github-development-loop.md`
- `docs/worker-subagent-orchestration-policy.md`
- `docs/round-closeout-reconcile.md`
- `fixtures/work-mode-benchmark/result-record.schema.json`
- `fixtures/work-mode-benchmark/results-template.csv`
