# Resource-Aware Worker Policy

## Purpose

Define and validate resource-aware worker policy flags for A2A broker worker
registration. This is a **source-only, fail-closed** module — it does not
inspect live host or gateway state, dispatch work, mutate state, or grant
runtime permissions.

## Policy flags

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `maxConcurrent` | number (optional) | — | Maximum concurrent tasks for this worker. Must be a positive integer when set. |
| `allowedTaskTypes` | `A2AExchangeIntent[]` (required) | — | Task types the worker is allowed to accept. Empty array = deny-all. |
| `noLiveSend` | boolean (required) | `false` | Forbid live/visible provider sends (Telegram, Hermes, etc.). |
| `noMutation` | boolean (required) | `false` | Forbid mutating broker or worker state. |
| `gatewayRequired` | boolean (required) | `false` | Worker requires a full OpenClaw Gateway on-device. |
| `mobileLowPower` | boolean (required) | `false` | Worker is battery/mobile with power constraints. |
| `standby` | boolean (required) | `false` | Accept no new tasks; drain existing ones. |
| `readOnly` | boolean (required) | `false` | Reject all mutations; only reads and evidence submission allowed. |

## Fail-closed rules

The module enforces these contradictions as validation errors (fail-closed):

1. **`standby` + `maxConcurrent > 0`** — standby should accept no new tasks.
2. **`noLiveSend` + `noMutation` + `!readOnly`** — both mutation and send are
   forbidden; the worker should declare itself `readOnly`.
3. **`readOnly` + `!noMutation`** — read-only requires no mutation.
4. **`readOnly` + `!noLiveSend`** — read-only requires no live sends.
5. **`noMutation` + `apply_local_change` in allowedTaskTypes** — applying
   local changes is a mutation.
6. **`noLiveSend` + `promote_to_live` in allowedTaskTypes** — promoting to
   live requires a live send.
7. **`mobileLowPower` + `maxConcurrent > 2`** — low-power workers should not
   accept more than 2 concurrent tasks.
8. **`gatewayRequired` + `mobileLowPower`** — Gateway is not a low-power
   runtime; this combination is contradictory.

## GO/NO-GO onboarding gates

### mobilealpha/Hermes workers

- Must be `readOnly`
- Must set `noLiveSend=true`
- Must set `noMutation=true`
- Must set `mobileLowPower=true`
- Must NOT set `gatewayRequired=true`
- Must NOT include `promote_to_live` in `allowedTaskTypes`
- Should limit `maxConcurrent` to ≤ 2

### mobilebeta-style workers

- Must set `gatewayRequired=true`
- Must NOT set `mobileLowPower=true`
- Must NOT be `readOnly`
- Should include `propose_patch` or `apply_local_change` in `allowedTaskTypes`

### Standard gateway workers

- Must set `gatewayRequired=true`
- Must NOT set `mobileLowPower=true`
- Must NOT be `readOnly`
- Should set `maxConcurrent` to a positive integer

### Team1 scheduling-attribution workers (workergamma lane)

- Must be `readOnly`
- Must set `noLiveSend=true`
- Must set `noMutation=true`
- Must NOT set `mobileLowPower=true` (runs on broker context, not battery)
- Must NOT include `promote_to_live` in `allowedTaskTypes`
- Should include `analyze` or `validate_change` in `allowedTaskTypes`
- Gateway not required

## Usage

### TypeScript (source)

```ts
import {
  validateResourceAwareWorkerPolicy,
  evaluateWorkerOnboarding,
  mobilealpha_HERMES_POLICY,
  mobilebeta_STYLE_POLICY,
} from "./core/resource-aware-worker-policy.js";

// Validate a policy
const result = validateResourceAwareWorkerPolicy({
  allowedTaskTypes: ["analyze", "validate_change"],
  noLiveSend: true,
  noMutation: true,
  gatewayRequired: false,
  mobileLowPower: true,
  standby: false,
  readOnly: true,
});
// → { ok: true, errors: [] }

// GO/NO-GO evaluation
const evaluation = evaluateWorkerOnboarding("mobilealpha-hermes", {
  allowedTaskTypes: ["analyze", "validate_change"],
  noLiveSend: true,
  noMutation: true,
  gatewayRequired: false,
  mobileLowPower: true,
  standby: false,
  readOnly: true,
});
// → { decision: "go", ... }
```

### Fixtures

Fixture JSON files in `fixtures/resource-aware-worker-policy/` provide
pre-computed GO/NO-GO evaluation examples:

| Fixture | Description |
| --- | --- |
| `mobilealpha-hermes.go.json` | Valid mobilealpha/Hermes mobile validation worker |
| `mobilealpha-hermes.no-go.json` | Hermes worker incorrectly requiring Gateway |
| `mobilebeta-style.go.json` | Valid mobilebeta-style gateway worker |
| `mobilebeta-style.no-go.json` | mobilebeta worker incorrectly set to readOnly |
| `termux-mobile.go.json` | Generic Termux mobile Hermes worker |
| `workergamma-scheduling.go.json` | Valid workergamma lane Team1 scheduling-attribution worker |
| `workergamma-scheduling.no-go.json` | workergamma worker incorrectly configured with promote_to_live |

Each fixture includes a `boundaries` section confirming the packet is
source-only and does not perform any live/runtime actions.

## Key files

| File | Purpose |
| --- | --- |
| `src/core/resource-aware-worker-policy.ts` | Types, validation, GO/NO-GO evaluation |
| `src/core/resource-aware-worker-policy.test.ts` | Tests |
| `fixtures/resource-aware-worker-policy/*.json` | GO/NO-GO fixture examples |
| `docs/resource-aware-worker-policy.md` | This document |

## Related

- [Worker capability registry](worker-capability-registry.md)
- [Worker subagent orchestration policy](worker-subagent-orchestration-policy.md)
- [Command center closeout checklist](command-center-closeout-checklist.md)
