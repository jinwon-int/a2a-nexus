# Feature Spec: A2AD Dialectic Review Mode

## Problem

Design reviews, incident analyses, policy decisions, and high-risk refactors benefit from structured
adversarial examination — thesis, challenge, defense, and synthesis — but A2A Plane today dispatches
only single-worker tasks or parent-round aggregates. There is no native work mode where multiple
workers examine the same problem from assigned roles and the broker synthesizes a final decision
packet.

The existing `trading.dialectic` implementation in the broker (`packages/broker/src/trading-dialectic/`)
is a specialized dialectic for trading decisions (spot, perp, futures, options). It is not
generalized for the broader review use cases called out in the roadmap:

- **Design review**: an architect proposes a design (thesis), a peer challenges it (antithesis),
  the author defends it (rebuttal), and a lead synthesizes the final decision (synthesis).
- **Incident analysis**: responders write the timeline (thesis), a separate reviewer flags gaps
  (antithesis), and management synthesizes action items.
- **Policy decisions**: proposal (thesis), impact analysis (antithesis), and final decision (synthesis).
- **High-risk refactors**: migration plan (thesis), risk/safety review (antithesis), and go/no-go
  decision (synthesis).

This spec fills that gap by defining the **A2AD dialectic review mode** — a generalized,
opt-in work mode with standardized role templates, evidence packet shapes, broker synthesis
handoff rules, and safety-invariant boundaries.

## User / operator stories

- As an operator, I want to dispatch a review task with explicit worker roles (e.g., reviewer,
  critic/libero, synthesis/finalizer) so that multiple perspectives are captured before an
  execution decision.
- As a reviewer (thesis role), I want to produce a structured position with claims, evidence,
  assumptions, and risk notes, so that the critic can challenge specific points.
- As a critic/libero (antithesis role), I want to produce counterclaims, failure modes,
  contradictions, and hard-block conditions, so that risks are surfaced before synthesis.
- As a synthesis/finalizer, I want to weigh thesis and antithesis, preserve dissenting notes,
  separate fact from assumption from recommendation, and produce a final decision packet.
- As a broker, I want to collect role-separated evidence without losing data, enforce
  phase ordering, and produce a read model that distinguishes each role's contribution.
- As an operator reviewing a completed dialectic, I want a clear summary of claims,
  counterclaims, risks, tests, and the final recommendation, with dissenting notes preserved.

## Actors

| Actor | Role in dialectic review | Phase |
| --- | --- | --- |
| **Reviewer (thesis)** | Proposes the initial position, claim, or design | `thesis` |
| **Critic / Libero (antithesis)** | Challenges the thesis with counterclaims, risks, and hard-block conditions | `antithesis` |
| **Author / Defender (rebuttal)** | Responds to challenges, defends claims, concedes risks (optional phase) | `rebuttal` |
| **Synthesis / Finalizer** | Weighs all positions, preserves dissenting notes, produces final decision | `synthesis` |
| **Broker** | Routes phases, enforces ordering, stores evidence, produces read model | all |
| **Operator** | Initiates the review, assigns roles, reviews output, decides execution | — |

## Scope

### In scope

- Generalized A2AD role templates derived from the trading.dialectic structure, suitable for
  design review, incident analysis, policy decisions, and high-risk refactors.
- Evidence packet shape with claim/counterclaim/risk/test/recommendation fields.
- Fact/assumption/recommendation separation in the synthesis output.
- Dissenting notes preservation (all positions remain visible in the read model).
- Broker synthesis handoff contract — how the broker collects phases and produces the read model.
- Opt-in workflow boundaries — dialectic mode is explicitly requested and does not replace
  ordinary worker task dispatch.
- Fixture file for A2AD dialectic review examples.
- Conformance test template for role schema validation.
- Integration reference pointing to the existing `trading-dialectic/` broker code.

### Out of scope

- Changes to the existing `trading.dialectic` trading-specific implementation.
- Production deploy, Gateway/broker/worker restart or reload unless explicitly approved.
- Live provider/Telegram canary or notification sends.
- DB mutation/prune/migration/replay.
- Manual Terminal Brief ACK/replay.
- Release/tag/npm publish.
- Secret movement or credential disclosure.
- Repository visibility change.
- History rewrite or force push.

## A2AD Role Templates

### Phase: thesis (reviewer)

The thesis role produces the initial position. Fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `author` | `AgentRef` | yes | Agent id, session key, and optional node id |
| `submittedAt` | ISO-8601 | yes | When the thesis was submitted |
| `title` | string | yes | Short label for the review position |
| `summary` | string | yes | Concise statement of the position |
| `claims` | string[] | yes | Specific claims being made |
| `evidenceRefs` | string[] | yes | References supporting each claim |
| `assumptions` | string[] | yes | Explicit assumptions underlying the position |
| `risksIdentified` | string[] | yes | Risks the author is aware of |
| `recommendation` | string | yes | What the reviewer recommends |
| `confidence` | number (0-1) | yes | Self-assessed confidence |
| `testCriteria` | string[] | no | How the position could be validated or disproven |

### Phase: antithesis (critic/libero)

The antithesis role challenges the thesis. Fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `author` | `AgentRef` | yes | Agent id, session key, and optional node id |
| `submittedAt` | ISO-8601 | yes | When the critique was submitted |
| `counterClaims` | string[] | yes | Claims that contradict the thesis |
| `failureModes` | string[] | yes | Specific ways the thesis could fail |
| `contradictions` | string[] | yes | Evidence or reasoning that contradicts thesis claims |
| `assumptionsChallenged` | string[] | yes | Thesis assumptions found questionable |
| `risksRaised` | string[] | yes | Additional risks not identified by the thesis |
| `blockFlags` | string[] | no | Hard-block conditions (policy violation, stale data, etc.) |
| `evidenceRefs` | string[] | yes | References supporting the counter-position |
| `confidence` | number (0-1) | yes | Self-assessed confidence in the challenge |

Block flag codes (hard conditions that block synthesis from proceeding normally):

| Code | Meaning |
| --- | --- |
| `data_stale` | The thesis relies on stale or superseded data |
| `policy_violation` | The thesis proposes something contrary to policy |
| `safety_boundary` | The thesis crosses a documented safety boundary |
| `factual_error` | The thesis contains a verifiable factual error |
| `scope_breach` | The thesis exceeds the agreed scope |

### Phase: rebuttal (author/defender, optional)

The rebuttal role responds to the critique. Fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `author` | `AgentRef` | yes | Agent id, session key, and optional node id |
| `submittedAt` | ISO-8601 | yes | When the rebuttal was submitted |
| `response` | string | yes | Overall response to the critique |
| `defendedClaims` | string[] | yes | Claims the author maintains despite the critique |
| `concededPoints` | string[] | yes | Points where the critique is accepted |
| `refinedAssumptions` | string[] | no | Updated assumptions after critique |
| `residualRisks` | string[] | yes | Risks that remain even after rebuttal |

### Phase: synthesis (finalizer)

The synthesis role weighs all phases and produces the final decision packet. Fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `author` | `AgentRef` | yes | Agent id, session key, and optional node id |
| `submittedAt` | ISO-8601 | yes | When the synthesis was submitted |
| `preserved` | string[] | yes | Facts/claims retained from thesis |
| `rejected` | string[] | yes | Claims explicitly rejected |
| `dissentingNotes` | string[] | yes | Objections preserved even when overruled |
| `facts` | string[] | yes | Established facts separated from opinion |
| `assumptions` | string[] | yes | Accepted assumptions (with confidence notes) |
| `risks` | string[] | yes | All risks identified across phases |
| `tests` | string[] | no | Verification tests for any remaining uncertainty |
| `recommendation` | string | yes | Final recommended action |
| `recommendationBasis` | string | yes | Why this recommendation was chosen |
| `verdict` | string | yes | One of: `APPROVE`, `APPROVE_WITH_CHANGES`, `REJECT`, `DEFER`, `ESCALATE` |

## Evidence Packet Shape

A completed A2AD review produces a structured evidence packet:

```json
{
  "kind": "a2ad.review.v1",
  "version": 1,
  "reviewId": "uuid-string",
  "title": "string",
  "submittedAt": "ISO-8601",
  "operatorRef": "string (issue URL or task id)",
  "roles": {
    "reviewer": { "agentId": "string", "sessionKey": "string" },
    "critic": { "agentId": "string", "sessionKey": "string" },
    "defender": { "agentId": "string", "sessionKey": "string" },
    "finalizer": { "agentId": "string", "sessionKey": "string" }
  },
  "phases": {
    "thesis": { "present": true, "data": { ... } },
    "antithesis": { "present": true, "data": { ... } },
    "rebuttal": { "present": false, "data": null },
    "synthesis": { "present": true, "data": { ... } }
  },
  "synthesisCard": {
    "verdict": "APPROVE",
    "facts": ["..."],
    "assumptions": ["..."],
    "risks": ["..."],
    "tests": ["..."],
    "dissentingNotes": ["..."],
    "recommendation": "string"
  }
}
```

### Evidence separation: fact / assumption / recommendation

The synthesis phase MUST produce three separate lists:

1. **Facts**: Verifiable, non-disputed statements that both the thesis and antithesis agree on,
   or that are established by external evidence. These are the stable foundation.
2. **Assumptions**: Statements accepted as true for decision-making but not verified. Each
   assumption SHOULD carry a confidence note and a suggested test for validation.
3. **Recommendation**: The final recommended action, derived from facts and assumptions.
   Includes a clear basis explaining the reasoning.

This separation is architecturally enforced in the evidence packet schema. A synthesis that
omits any of the three MUST be rejected by the broker as incomplete.

### Dissenting notes preservation

Every phase's full output is retained in the broker's read model. The synthesis `dissentingNotes`
field explicitly records objections or minority positions that were overruled but are
substantive enough to preserve. Examples:

- "The critic noted that data source X has known latency issues. Overruled because the
  real-time feed is confirmed current, but this note is preserved for production monitoring."
- "The reviewer wanted full migration in one sprint. Overruled because the risk assessment
  recommends phased rollout. The phased plan is the recommendation; a full migration may be
  revisited after phase 1."

The operator sees all dissenting notes in the final evidence packet, not just the accepted
position. This ensures the dialectic's integrity is preserved even when overruling a position.

## Broker Synthesis Handoff

### Phase ordering

The broker enforces this phase sequence:

```
thesis → antithesis → (rebuttal?) → synthesis
```

- `rebuttal` is optional. The operator or the initial configuration may skip it.
- Phases must not be submitted out of order. A `synthesis` submitted before `antithesis`
  MUST be rejected.
- `thesis` and `antithesis` are mandatory. A review without both sides is not a dialectic.

### Read model projection

The broker projects a read model from the stored phases, following the pattern established
by `TradingDialecticReadModelV1` in `packages/broker/src/trading-dialectic/read-model.ts`.

The A2AD read model includes:

- `kind`: `"a2ad.review.v1"`
- `reviewId`: stable review identifier
- `state`: one of the review states (see below)
- `phases`: structured per-phase data with present/absent flags
- `synthesisCard`: the final decision card when synthesis is complete
- `summary`: concise headline and decision summary

### Review states

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `OPEN` | Review created, awaiting thesis | `THESIS_SUBMITTED`, `CANCELLED` |
| `THESIS_SUBMITTED` | Thesis received, awaiting antithesis | `ANTITHESIS_SUBMITTED`, `CANCELLED` |
| `ANTITHESIS_SUBMITTED` | Antithesis received, awaiting rebuttal or synthesis | `REBUTTAL_SUBMITTED`, `SYNTHESIS_READY`, `CANCELLED` |
| `REBUTTAL_SUBMITTED` | Rebuttal received, awaiting synthesis | `SYNTHESIS_READY`, `CANCELLED` |
| `SYNTHESIS_READY` | All phases complete, finalizer is producing synthesis | `SETTLED`, `ESCALATED`, `CANCELLED` |
| `SETTLED` | Synthesis complete, decision available | terminal |
| `ESCALATED` | Decision escalated beyond the dialectic | terminal |
| `CANCELLED` | Review cancelled by operator | terminal |
| `FAILED` | Review failed due to error or timeout | terminal |

## Opt-In Workflow Boundaries

### Default disabled

A2AD dialectic review mode is opt-in. A task without an explicit `a2ad` mode declaration
is dispatched as a normal single-worker task. The mode is requested by including a `mode`
field in the task request:

```json
{
  "mode": "a2ad",
  "a2adConfig": {
    "roles": {
      "reviewer": { "agentId": "..." },
      "critic": { "agentId": "..." },
      "finalizer": { "agentId": "..." }
    },
    "includeRebuttal": false,
    "timeoutMinutes": 60
  }
}
```

### Compatibility with existing dispatch

- A2AD tasks are compatible with the existing task lifecycle (`queued`, `claimed`, `running`,
  `done`, `pr`, `blocked`, `cancelled`). A2AD is a *work mode*, not a new lifecycle.
- When a task completes in A2AD mode, the terminal evidence includes the complete A2AD evidence
  packet.
- Parent-round and handoff dispatches may include A2AD tasks as child lanes, so long as the
  participant workers are registered to the appropriate broker.

### Participant selection

- All dialectic roles must be assigned to registered workers or named agent refs before
  the review starts.
- The operator may assign the same worker to multiple roles, but the broker MUST warn when
  a single agent fills both `reviewer` and `critic` (defeats the adversarial purpose).
- The `finalizer` (synthesis) role SHOULD be a different agent from both `reviewer` and
  `critic` to ensure impartial synthesis.

## Success criteria

- [ ] A spec document exists at `docs/specs/a2a-dialectic-review-mode/spec.md` defining A2AD
  role templates, evidence packet shape, and broker synthesis handoff.
- [ ] A fixture file exists at `fixtures/contract/a2ad-review-mode.json` with example A2AD
  review data covering thesis, antithesis, rebuttal, and synthesis phases.
- [ ] A conformance test exists or is documented at `test/conformance/` that validates the
  A2AD evidence packet schema.
- [ ] The opt-in boundary is documented: normal tasks without `mode: "a2ad"` are unaffected.
- [ ] Dissenting notes preservation and fact/assumption/recommendation separation are documented
  as invariants.
- [ ] The existing `trading-dialectic/` broker source is cited as the implementation reference.
- [ ] All out-of-scope actions (deploy, restart, mutate DB, etc.) are explicitly excluded.

## Safety and approval boundaries

### Secrets and private data

- Role assignments reference agent IDs and session keys, never provider tokens, API keys,
  or raw credentials.
- Evidence packets contain only structured review data — no host paths, no secrets.
- The broker must redact `sessionKey` and `nodeId` fields from public-facing evidence
  unless the operator explicitly authorizes their inclusion.
- Runtime/bootstrap context file names (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`,
  `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`) must never appear in evidence fields.

### Human approval required for

- [ ] production deploy
- [ ] Gateway/broker/worker/service restart
- [ ] live canary/provider send
- [ ] DB mutation/prune/migration/replay
- [ ] manual Terminal Brief ACK/replay
- [ ] release/tag
- [ ] secret rotation/movement
- [ ] force push/history rewrite
- [x] none of the above

This spec is documentation-only. No production service changes are required.

### Broker foreground liveness

- A2AD mode uses detached subagent or script-based worker dispatch per phase, consistent
  with the existing worker task pattern. The broker foreground is not blocked during phase
  execution.
- The broker accepts phase submissions asynchronously and projects the read model on demand.

## Evidence contract

Each dialectic review produces this evidence:

- `reviewId` — stable identifier
- `title` — review title
- `operatorRef` — link to originating issue or task
- `roles` — agent assignments per role
- `phases` — per-phase structured data (all phases retained)
- `synthesisCard` — final verdict, facts, assumptions, risks, tests, dissenting notes, recommendation
- `summary` — concise headline and decision text

Artifacts for this specification:

- This spec document: `docs/specs/a2a-dialectic-review-mode/spec.md`
- Implementation tasks: `docs/specs/a2a-dialectic-review-mode/tasks.md`
- Fixture reference: `fixtures/contract/a2ad-review-mode.json`
- Broker reference: `packages/broker/src/trading-dialectic/` (trading-specific implementation)

## Rollback / failure handling

- **Failure indication**: broker rejects a phase submission due to ordering, schema, or
  agent authorization errors.
- **State restored**: review state remains at the last valid phase. Operator may cancel
  or reassign roles.
- **Safe cleanup**: cancellation of an A2AD review is non-terminal; evidence from completed
  phases remains available in the broker read model.
- **Approval-required cleanup**: none for this spec. Future implementation in broker source
  may require operator approval for role reassignment during an active review.

## Wiki/runbook follow-up

This spec creates reusable operating knowledge for:

- **Operators**: how to dispatch an A2AD review task with role assignments.
- **Workers**: what structured output each role must produce.
- **Finalizers**: how to weigh facts, assumptions, and dissenting notes in synthesis.
- **Maintainers**: how the A2AD mode integrates with the existing broker dispatch architecture.

Record this knowledge in the Team1 operator runbook (`docs/specs/a2a-team1-dispatch-wrapper/runbook.md`)
when A2AD dispatch support is added to the wrapper.

## Broker Implementation Reference

The existing `trading-dialectic/` broker source (`packages/broker/src/trading-dialectic/`)
provides the implementation pattern for A2AD:

| File | Purpose | A2AD equivalent |
| --- | --- | --- |
| `types.ts` | TypeScript type definitions for all phases, verdicts, states | Generalized types under `a2ad/review-*.ts` |
| `json-schema.ts` | JSON Schema for phase input/output validation | Generalized schema under `a2ad/review-schema.ts` |
| `read-model.ts` | Read model projection from stored task payload | Generalized projection for review packet |
| `summary.ts` | Headline and decision summary generation | Generalized summary for review outcome |
| `bangtong.ts` | Thesis agent prompt spec | Reviewer prompt spec |
| `dengae.ts` | Antithesis agent prompt spec | Critic/libero prompt spec |
| `seoseo.ts` | Synthesis agent prompt spec | Finalizer prompt spec |
