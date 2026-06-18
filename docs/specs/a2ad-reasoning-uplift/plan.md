# A2AD Reasoning-Performance Uplift Plan

Status: source-only plan for #885.  
Scope: evaluation/design packet only — no runtime mode switch, broker restart, provider canary, persisted memory schema, release, visibility change, DB mutation, or live worker behavior change is approved by this document.

## 1. Decision summary

A2AD reasoning uplift should **extend the existing dialectic infrastructure**, not create a parallel orchestration subsystem.

| Research input | A2A/A2AD mapping | Existing asset to reuse | First allowed implementation shape |
| --- | --- | --- | --- |
| ReAct | Worker alternates source inspection and evidence production | ordinary A2A task records + `a2ad-evidence-classifier` | evaluation label only; no new live dispatcher |
| Multi-agent debate | thesis / antithesis / synthesis | `docs/specs/a2a-dialectic-review-mode/*`, `packages/broker/src/decision-dialectic/*`, `a2a-dialectic-lite-finalizer` | extend dialectic fixtures/rubric |
| Reflexion | bounded retry after finalizer critique | finalizer comments, task evidence classifier, issue closeout notes | `reflexion-retry` design mode gated behind redaction rules |
| LATS / tree search | compare multiple candidate action paths | parent-round manifests + finalizer scoring | `tree-search-lite` offline evaluation only |
| SWE-style evaluation | issue-resolution quality metrics | GitHub issue/PR closeout records and CI status | static corpus + no-live replay harness |

Non-goal: "more agents" or "more verbose summaries" is not success. The evaluation must show better correctness or lower rework under the same safety constraints.

## 2. Baseline corpus and metrics

### Corpus

Use a redacted, source-only corpus of historical tasks with known outcomes:

1. **Simple invariant tasks** — ordinary mode should match advanced modes. Examples: docs wording fixes, package metadata fixes, narrow test-only regressions.
2. **Moderate GitHub/code tasks** — multi-file PRs where review blockers were found and fixed.
3. **A2AD failure tasks** — previous rounds with timeout, wrapper-only evidence, or non-substantive outputs.
4. **Safety-boundary tasks** — prompts that ask for live sends, visibility changes, secrets, DB mutation, release/tag, provider canary, or Terminal ACK. Expected outcome is block/escalate, not action.

Corpus entries must be data files, not one-off scripts. A candidate schema:

```json
{
  "id": "a2ad-eval-001",
  "sourceRefs": ["issue-or-pr-url", "commit-or-doc-path"],
  "taskClass": "simple|moderate|a2ad_failure|safety_boundary",
  "allowedTools": ["git", "filesystem", "gh-readonly"],
  "forbiddenActions": ["provider_send", "visibility_change", "db_mutation"],
  "expectedVerdict": "approve|changes_requested|block|defer|escalate",
  "expectedEvidenceClasses": ["source_backed", "ci_backed"],
  "redactionProfile": "public-safe"
}
```

### Metrics

| Metric | Definition | Must improve? |
| --- | --- | --- |
| `verdict_accuracy` | finalizer verdict matches known safe outcome | yes |
| `source_backed_claim_rate` | claims with file/line/command/URL evidence | yes |
| `wrapper_only_rate` | outputs classified wrapper-only/non-substantive | must decrease |
| `unsafe_action_attempts` | attempted live or approval-gated actions | must remain zero |
| `rework_count` | follow-up PR/review cycles needed to fix blockers | should decrease |
| `wall_time_seconds` | end-to-end elapsed time | bounded; may increase only with accuracy gain |
| `token_or_cost_units` | normalized model/tool cost | bounded by mode budget |
| `dissent_preservation` | hard objections preserved in finalizer output | yes for dialectic modes |

A mode fails promotion if it improves verbosity but not `verdict_accuracy` or `source_backed_claim_rate`.

## 3. Mode taxonomy and budget knobs

Modes are additive labels over existing A2AD infrastructure:

| Mode | Purpose | Budget knobs | Promotion gate |
| --- | --- | --- | --- |
| `baseline-linear` | current ordinary worker/finalizer path | 1 worker, 1 finalizer | control group |
| `dialectic-lite` | existing thesis/antithesis/synthesis shape | 2-4 workers, finalizer synthesis | already exists; use as baseline advanced mode |
| `reflexion-retry` | one bounded retry after finalizer critique | max retries 1, redacted reflection classes only | lower rework without storing raw transcripts |
| `tree-search-lite` | compare 2-3 candidate plans before implementation | max branches 3, no live actions | improves verdict accuracy on moderate tasks |

Budget knobs must be explicit in task metadata:

```json
{
  "reasoningMode": "dialectic-lite|reflexion-retry|tree-search-lite",
  "maxWorkers": 4,
  "maxReflectionRetries": 1,
  "maxCandidateBranches": 3,
  "maxWallTimeSeconds": 1800,
  "maxCostUnits": 1.5,
  "allowLiveActions": false
}
```

Default remains conservative. Advanced modes require explicit request (`a2ad` or a spec/eval harness run), and safety-boundary tasks must still fail closed.

## 4. Evidence schema changes

Extend existing task/finalizer evidence with evaluation-only fields first:

```json
{
  "reasoningEvaluation": {
    "mode": "dialectic-lite",
    "corpusId": "a2ad-eval-001",
    "evidenceClasses": ["source_backed", "ci_backed"],
    "dissentingNotes": ["string"],
    "reflectionRefs": ["redacted-reflection-id"],
    "candidateBranches": [
      { "id": "candidate-a", "verdict": "changes_requested", "evidenceRefs": ["file:line", "command:sha256"] }
    ],
    "safetyBlocks": ["visibility_change_requires_fresh_approval"],
    "metrics": {
      "verdictAccuracy": null,
      "wrapperOnly": false,
      "unsafeActionAttempted": false,
      "reworkCount": 0
    }
  }
}
```

Rules:

- Evidence refs must point to source files, command outputs, issue/PR URLs, or redacted artifacts.
- Raw chain-of-thought, raw transcripts, provider credentials, private endpoints, Telegram IDs, production data, and OpenClaw runtime/bootstrap files are forbidden.
- `wrapper_only` evidence never counts as substantive consensus.
- A finalizer may cite worker evidence but owns the final decision.

## 5. Reflection-memory redaction rules

`reflexion-retry` can only store compact, approved lesson classes:

| Class | Allowed content | Forbidden content |
| --- | --- | --- |
| `review_blocker_pattern` | "stale branch can pass old budget; recalc on current main" | PR-specific token dumps, private comments |
| `tooling_failure_pattern` | "queue_drain_timeout requires readback before retry" | raw broker payloads with secrets |
| `safety_boundary_pattern` | "visibility change needs fresh approval" | credentials, endpoints, chat ids |
| `test_strategy_pattern` | "add adversarial malformed-envelope probe" | raw production data |

Storage constraints:

- TTL/default expiry required for eval artifacts.
- Finalizer approval required before a reflection enters durable memory or a reusable skill.
- Prefer class-level skills for reusable procedure; do not persist PR numbers, SHAs, one-session task IDs, or stale artifact state.

## 6. Finalizer rubric

The finalizer output must separate:

1. **Facts** — source-backed, reproducible statements.
2. **Assumptions** — plausible but not proven statements.
3. **Dissent** — objections, hard blocks, minority views.
4. **Decision** — approve / changes requested / block / defer / escalate.
5. **Next action** — PR, issue split, closeout, or no-op.

Hard block conditions:

- missing source evidence for operational claims;
- wrapper-only worker outputs counted as consensus;
- live action requested without fresh approval;
- secret-bearing evidence or raw transcript leakage;
- invalid/missing CI or local verification for code-changing PRs.

## 7. Staged rollout gates

| Stage | Allowed work | Exit criteria |
| --- | --- | --- |
| S0 spec | this document and schema/rubric discussion | merged docs-only PR; no runtime change |
| S1 offline corpus | redacted corpus fixtures + evaluator script | evaluator runs locally; no live broker calls |
| S2 shadow evaluation | run modes against completed historical tasks | advanced mode improves accuracy/evidence without unsafe attempts |
| S3 opt-in A2AD eval | operator-requested no-live tasks only | finalizer confirms evidence quality and cost bounds |
| S4 runtime consideration | possible broker/worker mode tuning | separate fresh approval + PR + CI + rollback plan |

## 8. Dependency and sequencing

- #884-style wrapper-only/substantive-evidence semantics must remain fixed before any performance claim is trusted.
- #880/#882 optimization constraints apply: no per-round one-off scripts or npm wrappers. New evaluation data should be fixtures/manifests consumed by stable engines.
- #893 subagent activation tuning may provide more candidate evidence, but it must preserve safety invariants and should be evaluated through this corpus before changing defaults broadly.

## 9. Validation contract for this plan

This plan is complete for #885 when the PR verifies:

- existing dialectic assets are referenced and reused;
- baseline corpus categories and metrics are explicit;
- mode taxonomy and budget knobs are explicit;
- evidence schema additions are redacted/no-live;
- reflection-memory classes forbid raw transcripts/secrets;
- finalizer rubric and rollout gates are explicit.

No production behavior changes are included in this plan.
