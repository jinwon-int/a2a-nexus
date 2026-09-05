# Skills intake revise — `skills.skill-intake-revise.v1`

The bounded auto-revision round of the intake review gate
(`skills.skill-intake-review.v1`, jinwon-int/ccc-node#1357 R2). When an
independent review verdict is `revise`, the publisher dispatches exactly one
revision task to the AUTHOR node. The reviser is tool-blocked and edits only
the candidate copy in the packet; the publisher re-validates the returned
files through the full machine-gate path and opens a fresh intake PR that is
re-dispatched for independent review. A revision never bypasses any gate.

## Flow

```
review verdict = revise
  -> publisher posts verdict + findings on the intake PR (visibility)
  -> one skills_intake_revise task to the author node (this document)
       -> reviser returns revised skillFiles[] or drop_recommendation
  -> publisher re-gates the returned files (full envelope path)
       -> revised: fresh intake PR (new tree hash) -> new review dispatch
       -> drop_recommendation: recorded for the periodic human sweep
  -> round cap 2 per skill lineage, then the PR stays open for a human
```

There is no auto-close anywhere: a superseded PR stays open for the human to
close, a drop recommendation is a recommendation, and the round-cap handoff
is explicitly a human-judgment note.

## Packet schema — `skills.skill-intake-revise.v1`

Dispatch manifest `lanes[].payload`:

| Field | Type | Notes |
|---|---|---|
| `schema` | const `"skills.skill-intake-revise.v1"` | |
| `rubricVersion` | string | the review rubric the findings came from, e.g. `"2026-08-28.2"` |
| `scope` | string | `"fleet-internal"` (default) or `"public-elevation"` — same qualifier as the review packet |
| `skillName` | string | the candidate skill name |
| `provenance` | object | `author_node`, `provider`, `intake_pr` (number), `branch`, `head_sha`, `source_tree_sha256`, `revise_round`, `revise_round_limit` |
| `findings[]` | array | the structured review findings that motivated the revise verdict (`severity`/`area`/`note`) |
| `skillFiles[]` | array | the current candidate files as `{path, content}` — bounded: <=16 files, <=64KiB each |
| `reviseResultSchema` | object | the expected result shape (below), embedded so the worker needs no out-of-band schema |
| `workerProcedure` | string | this document's worker-procedure section |

Manifest shape: `requester` is the publisher (`role: operator`), the lane
`target` is the AUTHOR node with `role: publisher` (role vocabulary per the
#2013 expansion), `intent` is `skills_intake_revise`, and one lane per
revision round. Task ids are unique per round
(`skills_intake_revise-pr<pr>-<author>-<timestamp>`).

## Worker procedure — `skills-intake-reviser` (draft)

1. Read `findings[]` and the candidate copy (`skillFiles[]`) in full; touch
   nothing else. Do not fetch anything not present in the packet.
2. The revision is a **holistic edit**: regenerate the full revised file set
   rather than appending tail rules or monkey-patch addenda. A "Known
   limitations" section bolted onto an unchanged procedure is a rejection
   pattern, not a revision.
3. Keep the frontmatter `name` unchanged. Keep the `description` an honest
   what-and-when router with concrete trigger keywords (rubric area C) —
   revising the body while leaving the description undertriggering
   reproduces the original failure one session later.
4. Address every `major` and `blocker` finding. `minor`/`info` findings are
   addressed at discretion; anything unresolved is named in `changeSummary`.
5. Never weaken safety: no credentials, no node-identifying paths or raw
   secrets beyond what the packet's `scope` legitimately allows, no
   runtime-specific couplings, no gate-avoidance wording. The publisher
   re-runs every machine gate on the returned files regardless — a revision
   that reintroduces a gated pattern is discarded as a handler failure.
6. Keep the layout discipline: `scripts/` for deterministic steps,
   `references/` for on-demand docs, `assets/` for output resources; respect
   the packet's size bounds (<=16 files, <=64KiB each).
7. If the candidate is a single-incident checklist or otherwise cannot be
   generalized into a procedure a competent operator would keep (rubric area
   H), return `outcome: "drop_recommendation"` with the concrete reason
   instead of a cosmetic rewrite. Dropping is a recommendation — a human
   sweep decides.
8. Emit the result JSON only — no prose wrapper.

Safety: the reviser is tool-blocked and edits only the candidate copy in the
packet; it never pushes, never re-dispatches, and never sees the edge secret.
The publisher owns every side effect (re-gating, PR, re-review dispatch), and
its autonomy kill/dry-run states cover the whole round including dispatch.

## Result schema

```jsonc
{
  "outcome": "revised",            // "revised" | "drop_recommendation"
  "skillName": "<the skillName from the packet>",
  "sourceTreeSha256": "<the source_tree_sha256 from the packet>",
  "skillFiles": [                  // exactly when outcome=revised
    { "path": "SKILL.md", "content": "..." }
  ],
  "changeSummary": "<which findings were addressed and how>",
  "dropRecommendation": {          // exactly when outcome=drop_recommendation
    "reason": "<why this candidate should be dropped instead of revised>"
  },
  "model": "<runtime model id>",
  "reviser_node": "<your node id>"
}
```

Emit the result JSON only. A result that is malformed, or whose
`skillName`/`sourceTreeSha256` bindings do not match the packet, is a handler
failure — not a revision — and is consumed once without retry.

## Cost and round discipline

- Round cap: 2 revision rounds per skill lineage (author node + skill name,
  counted across the whole intake-PR chain, not per PR). At the cap the
  publisher posts a one-time handoff comment and leaves the PR to a human.
- Daily cap: per author node per UTC day (default 3, publisher-configured) —
  a revision dispatch beyond the cap is skipped and retried the next cycle.
- One revision dispatch per (intake PR, head): a failed or malformed result
  is consumed once and never automatically re-dispatched.

## Conformance

The contract envelope above is machine-checked by the deterministic,
no-network conformance checker `test/conformance/check-skills-intake-revise.mjs`
(fixture: `fixtures/contract/skills-intake-revise.json`, registered in the
conformance runner and in `check-contract-fixtures.mjs`). It enforces the
packet envelope (schema const, provenance incl. `provider` and
`revise_round`/`revise_round_limit` within the documented cap of 2,
skillFiles bounds, embedded result schema and workerProcedure pointer), the
motivation rule (findings must include at least one major or blocker — a
revise verdict over minor-only findings contradicts the review gate's
severity floor), and the result contract: exclusive shapes (outcome=revised
⇔ skillFiles + changeSummary, outcome=drop_recommendation ⇔
dropRecommendation.reason), the skillName/sourceTreeSha256 bindings, and
the reversed independence rule — `reviser_node` MUST be the packet's
`author_node`, because the revise round runs on the author node. Daily-cap
and one-dispatch-per-head discipline are publisher runtime behaviors and
stay out of the checker's scope.

## Status

- 2026-08-29: drafted as the R2 deliverable of jinwon-int/ccc-node#1357.
  Publisher implementation: ccc-node `scripts/ccc-skill-promotion.py`
  (verdict polling, revise dispatch, full re-gate republish).
