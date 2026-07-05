# A2A Nexus implementation pipeline

> **Status:** operator/process contract for #1347. This document is source-only: it does not approve broker/Gateway/worker restarts, provider sends, DB/outbox/ACK/replay/prune/migration, releases, tags, package publication, GitHub settings changes, or secret movement.

## Purpose

A2A Nexus already uses multi-lane A2A review for design and closeout, but medium-sized implementation work can still collapse into one overloaded implementation session. This pipeline makes the implementation path explicit for work that is too large or risky for a single ad-hoc edit.

The goal is not more bureaucracy. The goal is to catch seam mistakes, missing call sites, and semantic drift before a PR enters the normal A2A review/finalizer loop.

## When to use it

Use the pipeline by default for **Medium+ implementation work**, including:

- new gates, policy checks, evidence contracts, or broker/runner behavior;
- contract/schema changes that affect worker, broker, plugin, or runner interoperability;
- refactors touching two or more files;
- extraction work from large core files such as the #1289 R4 broker/store/server slices;
- changes where the intended behavior is “no behavior change”, but a missed call site would be costly.

You may skip the pipeline for:

- one-line fixes;
- docs-only edits;
- mechanical formatting or typo fixes;
- emergency operator-approved hotfixes where the issue/PR records the approval and follow-up verification plan.

When skipping it for a non-trivial change, write a one-line reason in the PR body or issue disposition. This follows the same reporting convention used by the #1297 plan mini-cycle/DW2-style small-cycle exceptions: deliberate omission is acceptable; silent omission is not.

## Roles and tiers

| Role | Cost tier | Responsibility | Output |
|---|---:|---|---|
| `explorer` | low-cost | Map the seam, affected files, call sites, tests, and risk points. Do not implement. | Short exploration note with source refs and proposed work boundary. |
| `implementer` | upper | Implement from the exploration note plus issue/round constraints. Prefer RED first for gates; for refactors, prove behavior preservation. | Branch/commit/PR candidate and test evidence. |
| `verifier` | upper | Separate session/context from the implementer. Review adversarially before PR publication or before merge if the PR already exists. | `PASS` or a bounded fix list with source refs. |
| optional `test-evidence` | upper or inherited | Run focused checks when the verifier needs an independent test-only pass. | Test command, exit code, and relevant output summary. |

Pipeline cap: **at most four subagents/sessions per implementation pipeline** unless the operator explicitly approves a larger wave. The `explorer` role stays low-cost by default; `implementer` and `verifier` use the tier needed to reason over the change safely.

## Standard flow

1. **Explorer pass**
   - Read the issue and current source.
   - List the target files, relevant call sites, existing tests, likely regression surface, and out-of-scope areas.
   - For refactors, name the preservation seam and what must remain byte/behavior-equivalent.
   - For gates/contracts, name the RED condition and the test that should fail before the implementation.

2. **Implementer pass**
   - Use the explorer note as input, not as authority. Re-check the source before editing.
   - For new gates/contracts: add the failing test or documented RED evidence first, then implement GREEN.
   - For behavior-preserving refactors: keep public surfaces stable, prefer delegators/free functions over semantic rewrites, and run the existing focused tests unchanged.
   - Keep the PR scope narrow and record explicit boundaries.

3. **Verifier pass**
   - Run in a separate context from the implementer.
   - Challenge the change against the original issue, explorer note, and diff.
   - Look specifically for missed call sites, changed dispatch semantics, source-projection/readback drift, hidden write-capable modes, and accidental live/runtime authority expansion.
   - Return either `PASS` or a bounded fix list. A fix list sends the work back to the implementer before normal A2A review.

4. **PR evidence**
   - In the PR body, record one concise line for the pipeline:
     - `Explorer: <one-line seam/risk summary>`
     - `Verifier: PASS` or `Verifier: requested fixes <summary>; resolved in <commit>`
   - This line is a process record, not A2AD quorum evidence.

5. **Normal A2A review/finalizer**
   - The verifier does **not** replace A2A review lanes or the finalizer.
   - Treat it as a pre-filter: if it catches an issue, it saves a review round; if it misses one, the existing A2A review/finalizer path remains the safety net.

## Relationship to A2A review rounds

The pipeline and A2A review answer different questions:

| Layer | Question | Counts as A2AD quorum? |
|---|---|---:|
| Explorer | “Where is the seam and what should change?” | No |
| Implementer | “Can we make the change with the promised boundary?” | No |
| Verifier | “Did this implementation violate the issue, seam, or tests before wider review?” | No |
| A2A review/finalizer | “Do independent lanes provide substantive review evidence for closeout?” | Yes, only when finalizer rules say so |

A verifier `PASS` must therefore never be worded as consensus. It is a local process checkpoint that the PR is ready for the normal repository and A2A gates.

## First-application gate

H1 is complete as a documentation/process lane once this document lands and the operator skill is updated. The practical GREEN condition is exercised by the next Medium+ implementation PR:

- the PR body includes an explorer note summary;
- the PR body includes a verifier `PASS` or a verifier fix/resolution line;
- local/CI gates pass;
- the finalizer records whether the pipeline reduced rework or surfaced gaps.

For the roadmap in #1353, N2/H3 is the preferred first real application: N2 is a Medium implementation and H3 can record the first scorecard/pipeline outcome.

## Safety boundaries

- The pipeline does not grant GitHub write access to source-only A2A lanes.
- It does not authorize live broker/Gateway/worker restarts, provider sends, DB/outbox/ACK/replay/prune/migration, releases, tags, package publication, GitHub settings changes, or secret movement.
- `github-propose-patch` remains write-capable; prompt text saying “proposal only” is not a safety boundary. Use source-only/read-only modes for analysis evidence.
- Worker outputs are recommendations. The finalizer still verifies source, tests, CI, PR state, and operator approvals.

## Minimal PR body snippet

```markdown
## Implementation pipeline
- Explorer: mapped `<seam>` across `<files>`; main risk was `<risk>`.
- Verifier: PASS — checked `<specific boundary/tests>`.
- Pipeline exception: <reason>  <!-- only when skipped -->
```

## Source references

- Issue #1347 defines H1 and the explorer → implementer → verifier contract.
- Issue #1353 schedules Wave 1 as H1 plus the 3-worker synchronization follow-up.
- `docs/a2ad-round-dispatch.md` defines source-only/no-live dispatch, source projection policy, designated antithesis, and the #1297 plan mini-cycle reporting convention.
- `docs/operators.md` defines finalizer handling for antithesis/mini-cycle evidence and independent review evidence.
