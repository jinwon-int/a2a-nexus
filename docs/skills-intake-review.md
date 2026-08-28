# Skills intake review — `skills.skill-intake-review.v1`

An A2A review gate for fleet-skills intake PRs, placed **before the human
sign-off**. It ports the proven nclex content-pipeline pattern (author-
disqualified trusted reviewer, signed receipts projected onto the exact head)
to the skill distribution network. Tracker: jinwon-int/a2a-nexus#2007; audit
context: jinwon-int/ccc-node#1347; graduation linkage:
jinwon-int/ccc-node `docs/skill-graduation.md`.

## Why

Auto-generated skills enter fleet-skills through draft intake PRs opened by
the publisher. Today the only gate after the node-side machine checks is a
human. An independent A2A reviewer — a keyring-registered worker that is
**never the authoring node** — gives every intake a structured, reproducible
second opinion before the human spends attention, and produces evidence the
human can re-verify.

## Flow

```
node autosave (machine gates x6) -> publisher opens draft intake PR
  -> A2A review round (this document):
       manifest -> trusted worker (author node excluded) -> verdict JSON
  -> receipt posted on the PR -> fleet-skills workflow verifies (keyring)
       -> commit status `a2a/receipts` projected on the exact head
  -> human final sign-off (reviewed_by) -> merge
```

The A2A PASS never replaces the human signature. There is no auto-close: a
`reject` verdict fails the gate (closed discipline) and the human decides.

## Packet schema — `skills.skill-intake-review.v1`

Dispatch manifest `lanes[].payload`:

| Field | Type | Notes |
|---|---|---|
| `schema` | const `"skills.skill-intake-review.v1"` | |
| `rubricVersion` | string | rubric id, e.g. `"2026-08-28.1"` |
| `provenance` | object | `author_node`, `intake_pr` (number), `branch`, `head_sha`, `source_tree_sha256` |
| `machineGate` | object | node-side gate results (secret scan, node-facts, dedup, structure lint, codex compat, claims) |
| `skillFiles[]` | array | `{path, content}` — bounded: <=16 files, <=64KiB each (same caps as staging) |
| `inventorySnapshot[]` | array | every `approved/` skill as `{name, audience, description}` (~40 rows; dedup judgment runs in-context, no vector store) |
| `verdictSchema` | object | the expected verdict shape (below), embedded so the worker needs no out-of-band schema |

## Verdict schema

```jsonc
{
  "verdict": "approve",           // "approve" | "revise" | "reject"
  "findings": [
    { "severity": "minor",         // "info" | "minor" | "major" | "blocker"
      "area": "structure",         // "secrets" | "duplication" | "claims" | "structure" | "utility"
      "note": "..." }
  ],
  "evidence": [                    // machine re-verifiable, mandatory for major/blocker
    { "kind": "grep", "detail": "pattern and match count over skillFiles" },
    { "kind": "url",  "detail": "claimed URL and observed HTTP status" }
  ],
  "model": "<runtime model id>",
  "reviewer_node": "<worker node id>",
  "head_sha": "<intake PR head at dispatch time>",
  "rubric_version": "2026-08-28.1"
}
```

A verdict without `evidence` for any major/blocker finding is malformed and
treated as a handler failure, not a verdict.

## Dispatch manifest example

```jsonc
{
  "roundId": "skills-intake-pr18-r1-20260901-0900",
  "brokerUrl": "https://<broker>",
  "requester": { "id": "seoseo", "role": "orchestrator" },
  "defaults": { "intent": "skills-intake-review" },
  "lanes": [
    {
      "target": { "id": "nosuk", "role": "reviewer" }, // keyring-registered; != author node
      "intent": "skills-intake-review",
      "message": "Review fleet-skills intake PR #18 (harness-managed-skill-catalog) per skills.skill-intake-review.v1; return the verdict JSON only.",
      "payload": {
        "schema": "skills.skill-intake-review.v1",
        "rubricVersion": "2026-08-28.1",
        "provenance": { "author_node": "gongmyoung", "intake_pr": 18,
                        "branch": "skill-intake/gongmyoung/harness-managed-skill-catalog-claude-9436cb40cb4f",
                        "head_sha": "<sha>", "source_tree_sha256": "<sha>" },
        "machineGate": { "secret_scan": "pass", "node_facts": "pass", "dedup": "pass",
                         "structure": "pass", "codex_compat": "n/a", "claims": "pass" },
        "skillFiles": [ { "path": "SKILL.md", "content": "..." } ],
        "inventorySnapshot": [ { "name": "gh-pr-flow", "audience": "shared",
                                 "description": "Ship code through the PR-first GitHub flow..." } ],
        "verdictSchema": { "see": "docs/skills-intake-review.md#verdict-schema" }
      }
    }
  ]
}
```

## Worker procedure — `skills-intake-reviewer` (draft)

The worker runtime executes its local agent over the packet. The procedure:

1. Read `skillFiles[]` in full. Do not fetch anything not present in the
   packet or named in `evidence` re-verification.
2. Apply the rubric in order; record a finding per failed check:
   - **secrets** — credential patterns, private endpoints, node-identifying
     paths (`/home/<user>`, IPs) that should not be public;
   - **duplication** — compare against every `inventorySnapshot[]` entry:
     same trigger conditions + same procedure = major (propose consolidation
     target instead);
   - **claims** — every pinned version, exit code, HTTP status, or URL must
     carry its own verification path; untraceable claims are major;
   - **structure** — frontmatter standard (name == dir, description
     20–1024), body >= 3 sections, procedure is executable as written;
   - **utility** — would a competent operator keep this after one use?
     Weak-utility alone caps at `revise`, never `reject`.
3. Bias controls: single candidate (no position comparison), structure
   over verbosity, reviewer runtime differs from the authoring runtime when
   the fleet allows, every major/blocker carries re-verifiable evidence.
4. Severity floor: any `blocker` forces `verdict: "reject"`. Any `major`
   forces at least `verdict: "revise"`.
5. Emit the verdict JSON only — no prose wrapper.

Safety: the reviewer never modifies the packet, never re-dispatches on a
failed verdict (result-preserving rerun discipline — a `handler` crash is a
crash, not a verdict; retry once, then reroute to a different trusted
worker), and never sees the edge secret.

## Receipt projection (Phase B)

On PASS, the publisher composes the receipt from the broker result —
`{task_id, head_sha, lane, reviewer_node, author_node, result}` — posts it on
the intake PR, and the fleet-skills `a2a-receipts` workflow (ported from
nclex) verifies it against the keyring and projects the `a2a/receipts`
commit status on the exact head. Merge discipline: human sign-off remains a
separate, explicit approval.

## Status

- Phase A (this document): schema, manifest example, worker procedure draft.
- Phase B: fleet-skills receipts workflow + `policies/REVIEW.md` revision.
- Phase C: publisher (`ccc-skill-promotion.py collect`) dispatch automation.
- First live run: one of fleet-skills #17–#20, after the operator approves
  the dispatch.
