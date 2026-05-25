# Tasks: A2AD Dialectic Review Mode Implementation

## Prerequisites

- [ ] PR for spec document (`docs/specs/a2a-dialectic-review-mode/spec.md`) is merged.

## Phase 1: Contract and fixtures

### 1.1 Fixture file

Create `fixtures/contract/a2ad-review-mode.json` with example A2AD review evidence covering:
- Full review with thesis, antithesis, rebuttal, and synthesis phases.
- Minimal review with thesis and synthesis only (no rebuttal).
- Review cancelled before completion.
- Synthesis with full fact/assumption/recommendation separation.
- Synthesis with dissenting notes preserved.

Acceptance: fixture passes conformance validation. No secrets, private paths, or
runtime/bootstrap file names appear in the fixture.

### 1.2 Conformance test

Create or update `test/conformance/check-a2ad-review-mode.mjs` that:
- Loads the A2AD fixture.
- Validates all required fields per phase.
- Enforces fact/assumption/recommendation separation in synthesis.
- Checks dissenting notes preservation.
- Verifies opt-in boundary (normal tasks without `mode: "a2ad"` are not affected).
- Confirms no forbidden content (secrets, host paths, runtime file names).

Acceptance: `node test/conformance/check-a2ad-review-mode.mjs` exits 0.

### 1.3 Contract document (optional)

Create `contracts/a2a/dialectic-review-mode.md` as a concise contract reference
(similar to `terminal-brief-core-contract.md` as the concise sibling of the feature spec).
This is optional and may be deferred to Phase 2.

## Phase 2: Broker source implementation

### 2.1 Generalize types

Create `packages/broker/src/a2ad/` directory with:

- `types.ts` — Generalized A2AD type definitions (review states, role templates,
  evidence packet, synthesis card).
- `json-schema.ts` — JSON Schema for phase validation.
- `read-model.ts` — Read model projection for A2AD review packets.
- `summary.ts` — Summary generation.

These should mirror the `trading-dialectic/` structure but with review-appropriate fields.

### 2.2 Role prompt specs

Follow the `bangtong.ts` / `dengae.ts` / `seoseo.ts` pattern:

- `reviewer.ts` — Thesis/reviewer prompt spec with A2AD output schema.
- `critic.ts` — Antithesis/critic prompt spec with A2AD output schema.
- `finalizer.ts` — Synthesis/finalizer prompt spec with A2AD output schema.

### 2.3 Broker integration

- Wire A2AD review creation into the broker task dispatch path.
- Add `mode: "a2ad"` detection to route tasks to the A2AD handler instead of normal dispatch.
- Enforce phase ordering (thesis → antithesis → [rebuttal] → synthesis).
- Store completed A2AD evidence packets in the task evidence record.
- Produce A2AD read model on demand.

### 2.4 Tests

- Unit tests for A2AD type validation, phase ordering, and read model projection.
- Integration test that dispatches an A2AD task through the broker and verifies the
  evidence packet shape.

## Phase 3: Dispatch wrapper integration (Team1)

### 3.1 A2AD support in team1-dispatch wrapper

- Add `--a2ad-spec` flag to `team1-dispatch` for A2AD review tasks.
- Include role assignment validation in dry-run mode.
- Document in the operator runbook (`docs/specs/a2a-team1-dispatch-wrapper/runbook.md`).

## Phasing notes

- Phase 1 is **spec-only** and creates no production risk. It may proceed without explicit
  operator approval beyond the spec PR merge.
- Phase 2 requires operator approval for broker source changes.
- Phase 3 requires operator approval for dispatch wrapper changes.

## Risk notes

- **Schema drift**: The A2AD types must be kept consistent with the trading-dialectic types
  as both evolve. A shared base type or cross-reference comment is recommended.
- **Role assignment conflicts**: Assigning the same agent to both reviewer and critic
  weakens the adversarial model. The broker should warn but not block — the operator
  may have valid reasons.
- **Phase timeout**: A long-idle phase (e.g., critic takes >24h) should have a timeout
  mechanism. Default: no timeout, operator may cancel explicitly.
- **Backward compatibility**: Normal task dispatch must be unaffected. A2AD is purely opt-in.
