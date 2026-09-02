# Skills intake review — `skills.skill-intake-review.v1`

An A2A review gate for fleet-skills intake PRs, placed as the **final
promotion gate** (owner decision jinwon-int/a2a-nexus#2030). It ports the
proven nclex content-pipeline pattern (author-
disqualified trusted reviewer, signed receipts projected onto the exact head)
to the skill distribution network. Tracker: jinwon-int/a2a-nexus#2007; audit
context: jinwon-int/ccc-node#1347; graduation linkage:
jinwon-int/ccc-node `docs/skill-graduation.md`.

## Why

Auto-generated skills enter fleet-skills through draft intake PRs opened by
the publisher. After the node-side machine checks, the A2A verdict is the
only remaining gate. An independent A2A reviewer — a keyring-registered
worker that is **never the authoring node** — gives every intake a
structured, reproducible review and produces signed evidence any operator
can re-verify.

## Flow

```
node autosave (machine gates x6) -> publisher opens draft intake PR
  -> A2A review round (this document):
       manifest -> trusted worker (author node excluded) -> verdict JSON
  -> receipt posted on the PR -> fleet-skills workflow verifies (keyring)
       -> commit status `a2a/receipts` projected on the exact head
  -> merge/promotion (the A2A verdict is final, #2030)
```

The A2A verdict is the final gate (owner decision jinwon-int/a2a-nexus#2030,
effective upon completion of the #2024 validation window on 2026-09-07).
There is no auto-close: a `reject` verdict fails the gate (closed discipline)
and escalates to the owner.

## Packet schema — `skills.skill-intake-review.v1`

Dispatch manifest `lanes[].payload`:

| Field | Type | Notes |
|---|---|---|
| `schema` | const `"skills.skill-intake-review.v1"` | |
| `rubricVersion` | string | rubric id, e.g. `"2026-08-28.2"` |
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
  "review_agent": "<agent family: claude | pi | ...>",
  "review_model": "<concrete model id, e.g. xai/grok-4.6>",
  "head_sha": "<intake PR head at dispatch time>",
  "rubric_version": "2026-08-28.1"
}
```

A verdict without `evidence` for any major/blocker finding is malformed and
treated as a handler failure, not a verdict.

### Review provenance fields (#2027)

`reviewer_node`, `review_agent`, and `review_model` are first-class verdict
fields. The canonical handler injects all three deterministically —
`review_agent` from the `REVIEW_AGENT_BIN` basename, `review_model` from an
explicit `--model` in `REVIEW_AGENT_ARGS` (falling back to the agent's
self-reported `model`). The publisher warns on stderr when a consumed verdict
is missing any of them; a warning is never a gate failure — verdicts composed
before the provenance handler rolled out remain valid (backward
compatibility).

## Dispatch manifest example

```jsonc
{
  "roundId": "skills-intake-pr18-r1-20260901-0900",
  "brokerUrl": "https://<broker>",
  "requester": { "id": "<publisher-node>", "role": "orchestrator" },
  "defaults": { "intent": "skills-intake-review" },
  "lanes": [
    {
      "target": { "id": "<trusted-worker>", "role": "reviewer" }, // keyring-registered; != author node
      "intent": "skills-intake-review",
      "message": "Review fleet-skills intake PR #18 (harness-managed-skill-catalog) per skills.skill-intake-review.v1; return the verdict JSON only.",
      "payload": {
        "schema": "skills.skill-intake-review.v1",
        "rubricVersion": "2026-08-28.2",
        "scope": "fleet-internal",
        "provenance": { "author_node": "<author-node>", "intake_pr": 18,
                        "branch": "skill-intake/<author-node>/<skill-name>-claude-<tree8>",
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
2. Apply the rubric in order; record a finding per failed check. Sources:
   the Agent Skills specification (agentskills.io/specification), the
   official `skill-creator` authoring guide (anthropics/skills), and the
   fleet's own gates. Rubric version: `2026-08-28.2`.

   **A. Safety — Lack of Surprise** (any hit = blocker)
   - malware, exploit code, or content aiding unauthorized access, data
     exfiltration, or deception;
   - the body's real intent diverges from what the description declares;
   - credential patterns, private endpoints, node-identifying paths
     (`/home/<user>`, IPs), or unpublished security knowledge (overlaps with
     the machine secret/node-facts gates — re-checked by eye).
   - **Scope qualifier (`payload.scope`, #2011 rollout):** for
     `fleet-internal` candidates (the default for this lane — the private
     canon exists precisely to hold fleet operational knowledge), node
     names and fleet topology are *acceptable content*, not findings;
     credentials, raw secrets, and exploitable detail remain blockers.
     The `public-elevation` scope applies the full clause above (that
     standard is reserved for skills headed to the public canon).

   **B. Spec conformance** (frontmatter + layout; failures = major unless
   cosmetic)
   - `name`: 1–64 chars, lowercase alphanumerics + hyphens, no
     leading/trailing/consecutive hyphens, **matches the directory name**;
   - `description`: 1–1024 chars, present;
   - optional fields used correctly: `license` (short name or bundled file),
     `compatibility` (<=500 chars, only when environment requirements exist —
     most skills need none), `metadata` (string→string map), `allowed-tools`
     (space-separated);
   - layout: `scripts/` for deterministic executable steps, `references/`
     for docs loaded on demand, `assets/` for output resources; multi-variant
     skills organize references per variant.

   **C. Triggering quality (description is the router; failures = major)**
   - describes BOTH what the skill does and when to use it;
   - carries concrete trigger keywords, phrased to counter undertriggering;
   - thin "Helps with X." descriptions are a finding.

   **D. Progressive disclosure** (failures = minor→major by impact)
   - SKILL.md ideally <500 lines; near the limit it must split into
     `references/` with explicit read-when pointers;
   - reference files >300 lines carry a table of contents;
   - the body does not duplicate what a bundled script executes.

   **E. Content quality** (failures = minor, patterns per `skill-creator`)
   - imperative instructions with reasons instead of heavy-handed MUSTs;
   - input/output examples where format matters;
   - output templates defined when the artifact shape matters;
   - general and transferable rather than narrowed to one past incident.

   **F. Claims verifiability** (untraceable pinned claim = major)
   - every pinned version, exit code, HTTP status, or URL carries its own
     verification path (citation, `file:line`, `--help` proof, dated
     verification marker).

   **G. Duplication** (same trigger + same procedure vs the
   `inventorySnapshot[]` = major)
   - propose the consolidation target instead of rejecting silently;
   - complementary overlap (different trigger, shared steps) = minor note.

   **H. Utility** (weak alone caps at `revise`, never `reject`)
   - would a competent operator keep this after one real use?
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
commit status on the exact head. Merge discipline: the keyring-verified
receipt plus the `approve` verdict are the final approval (a2a-nexus#2030).

## Conformance

The contract envelope above is machine-checked by the deterministic,
no-network conformance checker `test/conformance/check-skills-intake-review.mjs`
(fixture: `fixtures/contract/skills-intake-review.json`, registered in the
conformance runner and in `check-contract-fixtures.mjs`). It enforces the
packet envelope (schema const, provenance formats, 16-file / 64KiB-per-file
bounds, inventory row shape), the verdict schema (enums, severity floors —
blocker forces `reject`, major forces at least `revise` — and the evidence
mandate for major/blocker findings), author disqualification, and exact-head
binding between `verdict.head_sha` and `packet.provenance.head_sha`. Missing
`review_agent`/`review_model` are warnings, never gate failures (#2027
backward compatibility), and a `rubric_version` mismatch warns without
gating. The checker deliberately does not re-implement the review rubric:
rubric quality is the reviewer's judgment call.

## Status

2026-09-01: owner decision jinwon-int/a2a-nexus#2030 — the A2A verdict is
the final promotion gate; the human `reviewed_by` sign-off is retired once
the #2024 validation window closes (2026-09-07). Fail-closed receipts,
author/reviewer separation, and owner escalation on `reject` are unchanged.

2026-08-29: added `payload.scope` (`fleet-internal` default,
`public-elevation` for rare promotion-canon reviews) after the #2011
rollout showed fleet-internal candidates being revised solely for
containing the node roster the private canon exists to hold.

## Status

- Phase A (this document): schema, manifest example, worker procedure draft.
- Phase B: fleet-skills receipts workflow + `policies/REVIEW.md` revision.
- Phase C: publisher (`ccc-skill-promotion.py collect`) dispatch automation.
- First live run: one of fleet-skills #17–#20, after the operator approves
  the dispatch.
