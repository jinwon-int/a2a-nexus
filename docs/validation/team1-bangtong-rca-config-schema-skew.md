# Team1 workerGamma RCA: Gateway config/schema skew failure chain

Run: `a2a-config-schema-skew-prevention-20260511T120400Z`
Parent: a2a-plane#249 (a2a-plane#249, internal tracker private)
Lane: Team1/workerGamma, a2a-plane#250 (a2a-plane#250, internal tracker private)
Snapshot: `2026-05-12T02:30:00Z`

This is a redacted, evidence-only root cause analysis document. It does not deploy code, restart Gateway/broker/worker services, send live provider or Telegram messages, ACK terminal-outbox rows, mutate production data, rotate secrets, change repository visibility, rewrite history, force-push, release, or post community announcements.

## Incident anchor

On 2026-05-11 at 20:13 KST, Gateway restart failed after a config update that added `operatorEvents.crossBrokers` to `openclaw.json`. The plugin manifest `openclaw.plugin.json` `configSchema` did not define that property, and `additionalProperties: false` was enforced, so Gateway rejected the config with `must NOT have additional properties`. A cascading silence failure followed: Gateway restarts failed without clear diagnostics, and `openclaw status` did not surface the schema/config mismatch. The incident spanned approximately 20:13 to 20:44 KST before detection.

## Failure chain timeline

| Time (KST) | Event | Observation |
| --- | --- | --- |
| 20:13 | Config update adds `operatorEvents.crossBrokers` to `openclaw.json` | Field was documented as a future broker handoff feature |
| 20:13 | Gateway config validation triggered | `additionalProperties: false` rejects unknown property |
| 20:13 | Gateway restart attempt #1 | Restart fails — silent, no operator-visible alarm |
| 20:14–20:30 | Multiple restart retries | Each restarted Gateway fetches the same config, hits the same schema rejection, and fails silently |
| 20:30 | Operator checks `openclaw status` | Status output shows degraded state but does not directly surface schema mismatch |
| 20:30–20:44 | Triage period | Operator traces failure through logs, identifies schema/config skew |
| 20:44 | Root cause confirmed | `operatorEvents.crossBrokers` missing from `configSchema` |
| 20:44+ | Rollback / fix applied | Config reverted; manifest schema updated; restart succeeds |

## Root cause 1: Why the schema lacked `crossBrokers`

The `operatorEvents.crossBrokers` property was documented in the broker handoff protocol (`contracts/a2a/broker-handoff-protocol.md`) and referenced in cross-broker handoff fixtures (`brokerBeta-cross-broker-handoff.json`), but was never registered in the A2A plugin manifest schema (`openclaw.plugin.json` `configSchema`).

Three contributing factors:

1. **Feature development timeline gap**: The cross-broker feature was in active development (contract fixture work by Team2/workerEpsilon) while the plugin schema was maintained in a separate repository (`jinwon-int/openclaw-plugin-a2a`). The schema was not kept in lock-step with the cross-broker contract specification.

2. **No schema parity gate in config activate path**: When Gateway loads a plugin and activates its config, AJV validates the config against the manifest `configSchema`. But there was no pre-activation dry-run step that compares every key in the candidate config against the schema before writing it to `openclaw.json`. The config was written, Gateway was restarted, and only then did the schema rejection surface — by which time Gateway was already in a restart-failure loop.

3. **Config schema authoring is additive-only by convention**: The `additionalProperties: false` constraint was correct for fail-closed safety, but the schema lacked a negative test fixture that specifically injected a complete broker non-live config (including all documented-but-not-yet-schema-registered keys) and confirmed it fails closed. The schema parity test only validated known-good fixtures, not unknown-extension fixtures.

## Root cause 2: Why Gateway restarts failed silently

The Gateway config validation path (AJV schema check against `configSchema`) rejects invalid configs before Gateway fully initializes. The rejection is logged at Gateway startup, but:

1. **No structured restart-failure notification**: When Gateway fails to start with a config validation error, the failure is written to the Gateway log but there is no operator alerting channel (Telegram, Slack, etc.) that receives structured restart-failure events with the schema error details.

2. **Restart retry masking**: Each failed restart triggers a supervisor restart, which encounters the same config violation. The retry cycle produces repeated log entries, but no aggregated alarm threshold fired because the restart-failure detection did not distinguish between config-schema failures and other startup failures.

3. **Log volume**: In a multi-plugin Gateway environment, the specific schema rejection message (`must NOT have additional properties / operatorEvents/crossBrokers`) was present in logs but buried among other startup log lines, delaying operator discovery.

## Root cause 3: Why `openclaw status` didn't catch the schema skew

The `openclaw status` command reports Gateway health, plugin activation state, and runtime metrics. However:

1. **Status shows activation result, not config validity**: If Gateway never successfully activates the A2A plugin (because config validation failed), status reports the plugin as `inactive` or `error`, but does not display the specific schema violation that caused the activation failure. The operator sees a degraded plugin but not the root cause.

2. **No config-schema drift check in status**: `openclaw status` does not currently run a schema parity check comparing the active config against the plugin manifest `configSchema`. A standalone `openclaw config validate` or schema parity command would have surfaced the mismatch immediately.

3. **Status is a snapshot, not a pre-restart gate**: Status was checked reactively (during triage) rather than as a mandatory pre-restart gate. The config was changed and Gateway was restarted without a pre-restart status baseline or a config schema validation step.

## Recurrence prevention

### Immediate (this round)

1. **Schema type hardening** (PR #255): Narrow `edgeSecret` from `["string", "object"]` to `"string"` to prevent ambiguous config type tolerance. Tests validate string-accept and object/number-reject behavior.

2. **Libero validation matrix** (PR #253, workerDelta): Team1 config/schema skew libero matrix codifies the changed-key inventory, manifest parity, backward compatibility, pre-restart health, restart authorization, rollback readiness, and runtime hygiene gates required before any config change reaches a Gateway restart.

### Short-term hardening

1. Add a CI test that injects a config fixture with every documented-but-not-yet-schema-registered property and confirms the schema rejects unknown properties (fail-closed). The negative fixture must not silently pass.

2. Add a dedicated `openclaw config validate` or schema parity command that compares the active config file against the plugin manifest schema and reports specific mismatches. Wire this into the pre-restart checklist.

3. Add structured operator alerting for config-schema rejection at Gateway restart. If Gateway fails to start with a schema violation, surface the exact property path and schema error to the operator channel before the supervisor retry loop begins.

4. Lock the cross-broker contract specification and the plugin manifest schema together in the same repository or CI pipeline so that contract changes are reflected in the schema before either is merged.

### Long-term guard

1. Make `openclaw status` include a schema parity summary comparing the active config against all loaded plugin `configSchema` definitions. A mismatch (unknown property, missing required property, type error) should be surfaced as a status warning.

2. Gate every Gateway restart behind a pre-restart schema parity dry-run that fails the restart if the candidate config has properties not present in the schema, or if required properties are missing.

3. Add a release-gate invariant that verifies every key in the broker non-live config fixture has a corresponding entry in the A2A plugin `configSchema`, and that unknown keys are rejected with a specific error message.

## Evidence cross-reference

| Lane | Issue | PR | Artifact | Status |
| --- | --- | --- | --- | --- |
| workerGamma (RCA) | a2a-plane#250 | a2a-plane#255 | Schema type hardening + tests + this RCA | CI green, mergeable, needs RCA doc |
| workerDelta (libero matrix) | a2a-plane#251 | a2a-plane#253 | Libero validation matrix | OPEN |
| Team2 (parity) | a2a-plane#TBD | a2a-plane#254 | Team2 config schema parity | OPEN |

## Safe closeout

The safe closeout for a2a-plane#250 (a2a-plane#250, internal tracker private) is a PR/Done marker confirming the RCA analysis is documented and the schema hardening tests pass. The schema fix in PR #255 narrows the `edgeSecret` type tolerance, which is a valid hardening step for the config/schema skew prevention round. Any live restart, deploy, source-public execution, or approval execution remains **`NO-GO / Waiting`** until all sibling hardening evidence and explicit operator approval exist.

This RCA does not contain secrets, host-private paths, provider message IDs, or raw session dumps. All cross-references are to public repository artifacts (issues, PRs, contract fixtures).
