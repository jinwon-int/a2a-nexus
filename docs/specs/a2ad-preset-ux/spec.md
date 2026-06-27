# Feature Spec: A2AD Preset UX and Finalizer-Only Multi-Agent Review

## Problem

A2AD already provides broker-owned task lifecycle, worker attribution, heartbeat/read models, phase evidence, schema-checked verdicts, hard vetoes, and auditable finalizer decisions. The operator experience is still too heavy for routine review: operators must think in terms of broker task creation, worker inventory, phase child tasks, evidence links, and finalizer closeout every time.

Hermes MoA-style presets demonstrate the useful UX shape: reference lanes advise privately, an aggregator/finalizer is the only acting model, and a one-shot command can invoke the mode without changing the session permanently. A2AD should offer a similarly simple preset/shortcut surface while preserving A2A's stronger audit and safety contracts.

This spec defines a **spec-first contract** for A2AD preset UX. It does not approve production deploys, broker/Gateway/worker restarts, provider sends, DB/outbox mutation, package publishing, or visibility changes.

## User / operator stories

- As an operator, I want to invoke a named review preset such as `ops-risk-review`, `architecture-review`, `security-review`, or `release-readiness-review` without hand-writing every lane.
- As a finalizer, I want each official `broker A2AD` result to include broker/task/phase evidence and participant attribution before it can be called final.
- As a lane worker, I want my lane to be advisory by default, with side effects blocked unless I am the configured finalizer and the action has an explicit approval packet.
- As a maintainer, I want local multi-model review, local subagent debate, and single-agent structured review to be useful without being mislabeled as broker A2AD.
- As an auditor, I want concise public evidence in the default result and optional expansion to phase/task evidence without raw private scratch or secrets.

## Scope

### In scope

- Preset schema for A2AD review presets.
- Execution-mode taxonomy and naming rules.
- One-shot invocation semantics for `/a2ad <preset> <prompt>` and equivalent CLI/API/gateway commands.
- Broker A2AD adapter contract: preset -> broker round manifest -> phase task evidence -> finalizer closeout.
- Local non-broker review naming/reporting rules.
- Finalizer-only side-effect policy.
- Evidence visibility policy: public summary vs private scratch.
- Budget/latency/cost controls.
- Degraded/fallback disclosure rules.
- Benchmark/evaluation framing comparing broker A2AD, local multi-model review, local subagent debate, and single-agent structured review.

### Out of scope

- Production deploy, Gateway/broker/worker restart, canary, or provider send.
- Broker DB/outbox migration, prune, replay, or manual Terminal Brief ACK.
- Package release/tag/publish or repository visibility change.
- Secret rotation, credential movement, or secret value disclosure.
- Claiming Hermes MoA and A2AD are equivalent; they are adjacent layers with different trust and evidence models.

## Execution mode taxonomy

| Mode | Label in reports | Broker mutation | Minimum participants | May be called official `broker A2AD`? | Required evidence |
| --- | --- | --- | --- | --- | --- |
| `broker-a2ad` | `broker A2AD` | Creates broker tasks only through approved dispatch path | At least two non-finalizer advisory lanes plus one finalizer lane | Yes | Broker of record, parent round/task ids, worker ids, phase evidence refs, finalizer verdict, side-effect boundary |
| `local-multi-model-review` | `local multi-model review` | None | At least two model/reference lanes plus one aggregator | No | Model/preset ids when public-safe, aggregator output, downgrade statement |
| `local-subagent-debate` | `local subagent debate` | None | At least two local agent/subagent lanes plus one synthesizer | No | Local lane summaries, synthesizer output, no-broker statement |
| `single-agent-structured-review` | `single-agent structured review` | None | One agent | No | Single-agent disclosure and explicit “not A2AD” statement |

A result MUST NOT silently downgrade from `broker-a2ad` to a local or single-agent mode. If broker dispatch, quorum, worker attribution, or phase evidence fails, the result is `BLOCKED` or explicitly `degraded`, and it must not be labeled official `broker A2AD`.

## Preset schema contract

The machine-readable schema lives at [`preset.schema.json`](./preset.schema.json). A valid preset includes:

- `presetId` and `displayName`.
- `executionMode` from the taxonomy above.
- `sideEffectPolicy: finalizer-only`.
- `finalizer` lane with exactly one owner.
- Advisory lanes (`thesis`, `antithesis`, optional `rebuttal`) with participants or pools.
- `evidencePolicy` with public summary fields, private scratch policy, required evidence refs, redaction markers, and downgrade disclosure.
- `budget` with timeout, cost tier, max lanes, and optional token limits.
- `allowedSurfaces` for `/a2ad`, CLI, API, gateway command, or model-picker preset.

For `broker-a2ad`, the preset additionally requires:

- `brokerOfRecord`.
- `workerInventorySource`.
- broker/task/phase evidence refs in the final report.
- side-effect allowlist that is empty unless an explicit approval packet is attached.

## One-shot invocation semantics

`/a2ad <preset> <prompt>` is a shortcut for creating a review request from a named preset. Equivalent CLI/API/gateway commands may exist, but they must render the same normalized preset packet before dispatch.

Required behavior:

1. Load preset by `presetId`.
2. Validate against `preset.schema.json`.
3. Resolve execution mode.
4. For `broker-a2ad`, produce a dispatch-round-compatible manifest and run the existing fail-closed dispatch path.
5. For local modes, run local advisory lanes without broker mutation and label the report with the exact local mode.
6. Produce a default concise result with an execution-mode disclosure and participants.
7. Expose evidence expansion without raw private scratch.

## Finalizer-only side-effect policy

All thesis, antithesis, rebuttal, reference, critic, and advisory lanes are evidence-only. They may produce findings, risks, counterclaims, recommended tests, and proposed patches in text, but they must not publish, merge, deploy, restart, send provider messages, ACK/replay Terminal Brief, mutate DB/outbox, rotate secrets, tag, or force push.

Only the finalizer/aggregator may request side effects, and only after the relevant approval gate passes. A preset that allows side effects outside the finalizer lane is invalid.

## Evidence visibility policy

Default operator output should be concise:

- execution mode;
- broker of record when applicable;
- participants by lane;
- final verdict/status;
- key findings, risks, blockers, and side-effect boundary;
- evidence references.

Raw chain-of-thought, private scratch, runtime bootstrap files, secrets, private endpoints, provider IDs, Telegram IDs, and raw session dumps are not public evidence. Phase summaries and schema-checked verdicts are public-safe evidence when redacted.

## Failure and degraded reporting

A preset run must fail closed when:

- the preset schema is invalid;
- `broker-a2ad` lacks broker/worker inventory/finalizer evidence;
- required lanes are missing, duplicate, or non-terminal;
- a lane returns wrapper-only, blocked, provider failure, or empty substantive output;
- the finalizer draft omits evidence refs;
- a local/single-agent mode attempts to label itself A2AD.

Allowed fallback is explicit only: `requestedMode=broker-a2ad`, `actualMode=local-subagent-debate`, `status=degraded`, `notOfficialBrokerA2AD=true`, with a reason and operator-visible boundary.

## Benchmark / evaluation track

The evaluation track should compare at least:

1. single-agent structured review;
2. local multi-model review;
3. local subagent debate;
4. broker A2AD;
5. broker A2AD with tool/evidence interleaving when available.

Metrics should include correctness, blocker detection, hallucination rate, evidence completeness, latency, cost tier, downgrade disclosure accuracy, and side-effect boundary violations.

## Success criteria

- [x] Spec defines execution mode taxonomy and downgrade rules.
- [x] Preset schema validates lanes, broker of record, finalizer, side-effect policy, evidence policy, budget, and surfaces.
- [x] Fixture includes valid broker/local/single-agent examples and invalid downgrade/side-effect examples.
- [x] Tests reject invalid worker/lane/finalizer/side-effect/downgrade patterns.
- [x] Non-broker modes cannot label themselves official `broker A2AD`.
- [x] CI can validate the spec contract without live broker access.

## Safety and approval boundaries

This spec and its validation tests are read-only with respect to production. They do not deploy, restart, send providers, mutate DB/outbox, ACK/replay Terminal Brief, publish packages, change visibility, rotate secrets, or force push.

Any implementation that moves from spec validation to live broker dispatch, external publication, deployment, or restart requires a separate approval packet with scope and rollback notes.

## Rollback / failure handling

Because this change is docs/schema/test only, rollback is reverting the spec files, fixture, test, and package script. No runtime state needs cleanup. If a preset run later fails at runtime, the finalizer reports `BLOCKED` or explicit degraded mode and preserves the broker/task evidence needed for retry.
