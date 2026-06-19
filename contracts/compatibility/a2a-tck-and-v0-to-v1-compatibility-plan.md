# A2A TCK and v0→v1 compatibility plan

> **v0 Freeze (2026-05-09):** The Contract v0 baseline is frozen. This document is the first TCK
> lane (issue #916) and the v0→v1 compatibility policy that any future schema, capability, or
> terminal-evidence change must satisfy. No new lifecycle states, receipt levels, capability
> labels, or result types may be added before this plan is ratified.
>
> Issue: #916. Wave tracker: #922. Parent: #915.

## Purpose

This document is the smallest PR-first slice of the A2A Nexus Technology Compatibility Kit (TCK)
and v0→v1 compatibility plan. It does three things:

1. Maps every frozen v0 contract to a TCK category with an executable check command.
2. Defines the v0→v1 compatibility rules for additive changes, deprecations, schema
   versioning, worker capability evolution, and terminal evidence semantics.
3. Classifies which existing checks remain fixture validators and which are promoted
   TCK gates for external broker/harness conformance.

It deliberately stops short of being a live external-broker harness. The TCK is fixture- and
doc-driven, with no-live conformance references like
[`fixtures/external-harness/no-live-conformance.json`](../../fixtures/external-harness/no-live-conformance.json)
remaining the canonical public-safe starting point. Live broker assertions are an explicit
later slice.

## Scope

In scope for this PR-first slice:

- TCK category map for the v0 frozen contracts (lifecycle, workers, terminal evidence,
  cross-broker handoff, capability profile, embedded stability, adapter receipt capability,
  harness-neutral analysis adapter, GitHub evidence projection, public compatibility policy,
  external harness no-live).
- v0→v1 compatibility rules (additive only / deprecations / schema versioning / worker
  capability evolution / terminal evidence semantics).
- Gate classification of existing fixture/document validators.
- Reference to the existing no-live external-harness fixture.
- Lightweight contract section citation convention for task packets.

Explicitly out of scope (later slices):

- Live broker-backed external harness runner.
- Auto-promotion of `public-compatibility-policy.json` to a stable v1.
- A v1 freeze that adds new lifecycle states, receipt levels, or worker capability labels.

## TCK categories

Each category is a frozen v0 contract plus its existing executable check. The TCK gate is the
classification that consumers (broker, plugin, runner, future external harnesses) must satisfy.

| ID | Title | Frozen contracts (path) | Gate type | Existing check command |
| --- | --- | --- | --- | --- |
| `task-lifecycle` | Task lifecycle states and transitions | `contracts/a2a/task-lifecycle.md`, `fixtures/contract/task-lifecycle.json` | tck-gate | `node test/conformance/check-contract-fixtures.mjs` |
| `worker-registration` | Worker registration fields and capability labels | `contracts/a2a/worker-registration.md`, `fixtures/contract/worker-registration-capabilities.json` | tck-gate | `node test/conformance/check-contract-fixtures.mjs` |
| `cancellation-idempotency` | Cancellation + idempotency scenarios | `contracts/a2a/cancellation-idempotency.md`, `fixtures/contract/cancellation-idempotency.json` | tck-gate | `node test/conformance/check-contract-fixtures.mjs` |
| `terminal-evidence` | Result types + receipt levels + accepted-send non-ACK | `contracts/a2a/terminal-semantics.md`, `contracts/compatibility/terminal-evidence-ack-boundary.md`, `fixtures/contract/terminal-evidence.json`, `fixtures/terminal-evidence/accepted-send-non-ack.json` | tck-gate | `node test/conformance/check-terminal-evidence-ack-boundary.mjs` |
| `worker-capability-profile` | R31 worker capability profile schema | `contracts/a2a/worker-capability-profile.md`, `fixtures/contract/worker-capability-profile.json` | tck-gate | `node test/conformance/check-contract-fixtures.mjs` |
| `embedded-execution-stability` | Embedded OpenClaw execution stability policy | `contracts/a2a/embedded-execution-stability-policy.md`, `fixtures/contract/embedded-execution-stability-policy.json` | tck-gate | `node test/conformance/check-contract-fixtures.mjs` |
| `adapter-receipt-capability` | Adapter receipt capability levels C1–C6 | `contracts/a2a/adapter-receipt-capability.md`, `fixtures/contract/adapter-receipt-capability.json` | tck-gate | `node test/conformance/check-contract-fixtures.mjs` |
| `harness-neutral-analysis-adapter` | Harness-neutral analysis evidence classes | `contracts/a2a/harness-neutral-analysis-adapter.md`, `fixtures/contract/harness-neutral-analysis-adapter.json` | fixture-validator | `node test/conformance/check-contract-fixtures.mjs` |
| `cross-broker-handoff` | Cross-broker handoff protocol | `contracts/a2a/broker-handoff-protocol.md`, `fixtures/contract/gwakga-cross-broker-handoff.json` | tck-gate | `node test/conformance/check-contract-fixtures.mjs` |
| `github-evidence-projection` | GitHub comment evidence ledger extension | `contracts/a2a/github-evidence-projection.md`, `fixtures/contract/github-evidence-projection.json` | fixture-validator | `node test/conformance/check-github-evidence-projection.mjs` |
| `public-compatibility-policy` | Public compatibility policy invariants | `fixtures/contract/public-compatibility-policy.json` | fixture-validator | `node test/conformance/check-contract-fixtures.mjs` |
| `external-harness-no-live` | External harness no-live conformance | `fixtures/external-harness/no-live-conformance.json`, `docs/external-harness-quickstart.md` | tck-gate | `npm run check:external-harness-conformance` |

The category list, gate types, and check commands are mirrored in the machine-readable fixture
[`fixtures/compatibility/a2a-tck-and-v0-to-v1-compatibility-plan.json`](../../fixtures/compatibility/a2a-tck-and-v0-to-v1-compatibility-plan.json).

## v0→v1 compatibility rules

Any change to a v0 frozen contract — lifecycle states, transitions, result types, receipt
levels, capability labels, worker registration fields, or handoff protocols — must satisfy
all five rules below. The rules are cumulative: a breaking change must clear all five gates.

### Additive changes

- **Additive only.** v0→v1 may add new optional fields, new lifecycle states that do not
  change existing transitions, new optional capability labels, or new harness-neutral
  evidence classes.
- **Additive changes never remove or rename** any frozen field, label, state, or
  transition. Renames require a deprecation cycle (see below).
- **Default behaviour must not change.** A v1 consumer receiving a v0 message must produce
  the same observable behaviour as a v0 consumer receiving that message.

### Deprecations

- Deprecations are explicit and time-bounded. A deprecated field must remain parsable and
  emit a documented warning for at least one minor version cycle before removal.
- A v0→v1 PR that removes a frozen field must include a deprecation commit and a migration
  note that lists every broker, plugin, runner, and fixture that consumed the field.
- Deprecation entries must be added to
  [`contracts/compatibility/matrix.md`](./matrix.md) with a removal gate version (for
  example `to-remove-in-v1.1`).

### Schema versioning

- **Major version bump is mandatory** for any breaking change, even within a `0.x` release
  train. The Contract v0 line stays at `v0` until the team ratifies a v1 freeze issue.
- Frozen contracts carry an explicit `v0Freeze.frozenAt` marker (currently `2026-05-09`).
  The marker is a contract artefact, not a GitHub Release / npm / Docker tag.
- Schema versions live alongside the contract (`contractVersion` field) and inside the
  matching fixture (`v0Freeze.frozenAt`). New versions are required to add a new fixture
  with a distinct `fixtureId` (`a2a-nexus.compatibility.<name>.v2`) and to keep the v0
  fixture unchanged until deprecation closes.
- **Breaking changes require a major version bump**, even within a `0.x` release train, and
  must cite the migration issue in the PR body.

### Worker capability evolution

- New `workloadStrengths` labels are additive and may land in a minor version once the
  label is referenced from at least one worker registration fixture.
- Removing or renaming an existing label is a breaking change and triggers the schema
  versioning rule above.
- The `freshnessTimestamp` field and the stale-profile handling (stale-warning vs
  stale-expired) are frozen as part of R31. Any change to staleness thresholds or to
  fallback heuristics must ship with a new fixture exercising the new path and must
  update `contracts/a2a/worker-capability-profile.md`.
- Worker capability profiles must remain public-safe: no host names, private paths,
  provider tokens, raw session dumps, or runtime/bootstrap context file names (the
  protected deny-list is enforced by the existing
  `node test/conformance/check-contract-fixtures.mjs` gate).

### Terminal evidence semantics

- The four receipt levels (accepted-send, requester-visible, operator-visible, terminal
  ACK) and the three result types (Done, PR, Block) are frozen.
- The **accepted-send non-ACK boundary** is locked: `providerMessageId`,
  `providerAccepted`, `sendStatus: accepted`, `sendStatus: sent`, `queue_accepted`, and
  `spool_produced` are never terminal ACK evidence. Only `manual_operator_receipt` and
  `current_session_visible` are ACK-safe receipt proofs.
- Terminal ACK is not derivable from provider delivery responses. Any future addition to
  the ACK-safe set requires a v1 freeze issue that demonstrates the new proof can be
  observed in current-session-visible form.
- GitHub comment evidence projection remains a manifest-bound, idempotent, replay-safe
  ledger entry — never terminal ACK, read receipt, visibility proof, or operator approval.

## Fixture validators vs TCK gates

Each existing check is classified so consumers know what counts as a public TCK gate versus
an internal fixture-validator.

- **TCK gates** are checks an external broker or harness must satisfy to claim A2A Nexus
  v0 compatibility. They are part of the public compatibility surface.
- **Fixture validators** are internal integrity checks for the contract fixtures
  themselves. They keep the public surface honest but are not themselves a v0 compatibility
  claim.

Current classification:

| Check command | Kind | Why |
| --- | --- | --- |
| `node test/conformance/check-contract-fixtures.mjs` | fixture-validator | Validates fixture JSON shape, schema, and forbidden-content rules. Not a runtime claim. |
| `node test/conformance/check-terminal-evidence-ack-boundary.mjs` | tck-gate | Locks the accepted-send non-ACK boundary. Any v0 claim must keep this green. |
| `node test/conformance/check-github-evidence-projection.mjs` | fixture-validator | Validates the GitHub comment evidence projection fixture. |
| `node test/conformance/check-a2a-tck-plan.mjs` | tck-gate | Validates the TCK plan spec, fixture, gate mapping, and external-harness reference. |
| `npm run check:external-harness-conformance` | tck-gate | Validates `docs/external-harness-quickstart.md` and `fixtures/external-harness/no-live-conformance.json`. External brokers must satisfy this gate to claim a no-live integration. |
| `npm run check:quickstart-conformance` | fixture-validator | Internal quickstart integrity. Not a public claim. |
| `npm run check:promotion-capstone` | fixture-validator | Internal promotion capstone integrity. |
| `npm run check:terminal-brief-routing` | fixture-validator | Internal Terminal Brief routing integrity. |
| `npm run check:message-id-ack-boundary` | tck-gate | Locks provider message-id evidence as non-ACK. Required for v0 ACK boundary claims. |

This classification is mirrored in the `gateMapping` block of
[`fixtures/compatibility/a2a-tck-and-v0-to-v1-compatibility-plan.json`](../../fixtures/compatibility/a2a-tck-and-v0-to-v1-compatibility-plan.json).

## External harness fixture

The canonical no-live external harness fixture lives at
[`fixtures/external-harness/no-live-conformance.json`](../../fixtures/external-harness/no-live-conformance.json).
It is the smallest public-safe starting point for a non-OpenClaw broker/harness that wants to
claim A2A Nexus v0 compatibility without touching a live broker.

Fixture invariants enforced by `npm run check:external-harness-conformance`:

- `mode` is `no-live` and every `safety.*` flag is `false`.
- `broker.baseUrl` is the loopback `http://127.0.0.1:8787` and `production` is `false`.
- `harness.usesOpenClawCli` is `false`; OpenClaw is the first/reference integration, not a
  required dependency.
- The task is idempotent, replay-safe, and expects only `Done` or `Block` terminal evidence.
- Terminal Brief receipt sources are limited to `current_session_visible` and
  `manual_operator_receipt`; `provider_accepted`, `provider_sent`, `queue_accepted`, and
  `spool_produced` remain non-ACK evidence.
- The `(N/N)` final-count label is framed as a closeout candidate input only — never an
  automatic irreversible action.

External brokers that want to claim a v0 conformance slice MUST keep their own fixture
in this shape and MUST keep the OpenClaw dependency out of the conformance path.

## Contract section citation

Future task packets may cite contract section IDs (for example
`contracts/a2a/task-lifecycle.md#lifecycle-states`) so reviewers can trace a change back to
the frozen contract without slowing ordinary small tasks.

Citation rules:

- **Non-blocking.** Missing or stale citations never block a small task; they only appear in
  the TCK plan evidence when the change touches a v0 frozen contract.
- **Optional for additive-only changes.** A patch that adds an optional field to a worker
  profile, a new optional `workloadStrengths` label, or an extra fixture evidence class
  may omit citation as long as the TCK plan fixture still classifies the change as
  additive-only.
- **Required for breaking-change candidates.** Any PR that proposes removing a frozen
  field, renaming a state, changing a transition, or relaxing the accepted-send non-ACK
  boundary MUST cite the relevant section IDs and link to the v1 freeze issue that
  ratifies the change.
- **Lightweight format.** Citation lines look like:
  `Refs: contracts/a2a/task-lifecycle.md#lifecycle-states (additive)` or
  `Refs: contracts/compatibility/terminal-evidence-ack-boundary.md#rules (breaking)`.
  Reviewers parse them with a regex over the PR body and the issue body; no tool is
  required.

## Safety boundary

This slice stays inside the #915 / #922 / #916 safety envelope:

- No release, tag, npm publish, Docker publish, or visibility change.
- No live deploy, broker/worker/gateway restart, DB mutation, or historical replay.
- No provider, Telegram, Hermes, or OpenClaw message send; no Terminal Brief ACK/replay.
- No secret movement; no runtime/bootstrap context file leakage (the
  `test/conformance/check-a2a-tck-plan.mjs` gate enforces the protected filename list
  as a deny-list, not by referencing those filenames in docs).
- No crossBroker mutation; no canonical source flip.

The TCK gate and the external harness fixture are no-live by construction. Any future slice
that promotes a check from `fixture-validator` to `tck-gate` or that adds a live broker
harness MUST open a follow-up issue that re-states this safety boundary and obtain explicit
operator approval before merge.

## Related artefacts

- Spec: this document.
- Machine-readable fixture:
  [`fixtures/compatibility/a2a-tck-and-v0-to-v1-compatibility-plan.json`](../../fixtures/compatibility/a2a-tck-and-v0-to-v1-compatibility-plan.json).
- Conformance gate: `node test/conformance/check-a2a-tck-plan.mjs`.
- External harness gate: `npm run check:external-harness-conformance`.
- Parent tracker: #915.
- Issue: #916. Wave: #922.
