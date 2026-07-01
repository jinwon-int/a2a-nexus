# Team1 config/schema skew prevention libero validation matrix

Run: `a2a-config-schema-skew-prevention-20260511T120400Z`
Parent: a2a-plane#249 (a2a-plane#249, internal tracker private)
Lane: Team1/yukson, a2a-plane#251 (a2a-plane#251, internal tracker private)
Snapshot: `2026-05-11T15:20:00Z`

This is a redacted, no-live libero validation matrix for preventing config/schema skew from breaking Gateway restart. It is evidence-only: it does not deploy code, restart Gateway/broker/worker services, send live provider or Telegram messages, ACK terminal-outbox rows, mutate production data, rotate secrets, change repository visibility, rewrite history, force-push, release, or post community announcements.

## Incident anchor

The triggering class of failure is: `operatorEvents.crossBrokers` was present in `openclaw.json` while the plugin manifest `openclaw.plugin.json` `configSchema` did not allow that property, so Gateway config validation rejected restart with `must NOT have additional properties`. The local fix for the original incident is useful evidence, but future config changes still require a fail-closed validation gate before any restart or deploy.

## Libero verdict

**Decision: `NO-GO / Waiting` for any live restart or source-public execution.** The matrix is complete enough for this documentation lane, but aggregate GO is not safe until the sibling hardening lanes provide terminal PR/Done/Block evidence, the exact changed config keys are proven schema-aligned, `openclaw status` is clean, and a dry-run schema parity check passes against the same manifest/config pair that will be restarted.

A Start marker or an unmerged PR is not sufficient restart evidence. If any required artifact is missing, stale, redacted beyond verification, or shows a schema/config mismatch, the safe result is `NO-GO` and no restart.

## Config/schema change GO/NO-GO matrix

| Gate | Required condition before GO | NO-GO trigger | Evidence required |
| --- | --- | --- | --- |
| Changed key inventory | Every changed config key is listed with owner, file path, and expected schema path. | A config key appears in runtime config but is not mapped to a manifest schema property. | Redacted diff summary naming keys, e.g. `operatorEvents.crossBrokers`, without secrets or private endpoints. |
| Manifest parity | `openclaw.plugin.json` `configSchema` accepts every changed key and rejects unknown siblings. | Gateway would reject config with `must NOT have additional properties` or equivalent schema error. | Schema parity check output against the exact candidate `openclaw.json` + manifest pair. |
| Backward compatibility | Existing deployed config remains valid, or migration/defaulting is documented. | Required property is added without default/migration, or old config fails validation. | Compatibility fixture or command output showing old and new config validation results. |
| Pre-restart health | `openclaw status` is collected before restart and shows the current baseline health. | Status command is missing, stale, or indicates an unrelated critical failure that could hide skew. | Timestamped, redacted `openclaw status` summary; no host-private paths, secrets, or raw session dumps. |
| Restart authorization | Operator approval explicitly names the ref, config file, manifest, restart target, and rollback path. | Approval is implicit, inferred from PR/Done comments, or does not name restart scope. | Operator approval record separated from technical evidence. |
| Rollback readiness | Prior known-good config/manifest ref and service recovery procedure are documented. | No restoration path exists if validation or restart fails. | Rollback note with exact ref names or redacted artifact digests. |
| Runtime hygiene | Branch diff, PR body, issue comments, and artifacts exclude OpenClaw runtime/bootstrap context files. | `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` would enter branch or evidence. | Fail-closed guard output listing exact repo-relative offending paths, then Block instead of PR/Done. |

## Pre-restart checklist

1. Confirm the candidate branch is free of runtime/bootstrap context files and secrets.
2. Run the schema parity validator against the exact `openclaw.json` and `openclaw.plugin.json` that will be used by Gateway.
3. Verify changed keys are present in `configSchema` and unknown keys still fail closed.
4. Run `openclaw status` and save only a redacted health summary.
5. Confirm CI/test evidence for schema parity, compatibility fixtures, and documentation gates.
6. Obtain explicit operator approval for the named restart target and rollback path.
7. Only then perform the approved restart; otherwise keep `NO-GO / Waiting`.

## Evidence requirements for config changes

- Redacted key inventory and schema-path mapping for each changed config field.
- Validator command, version/ref, input artifact digests, and pass/fail output.
- `openclaw status` pre-restart summary and any post-validation status summary.
- Compatibility result proving old deployed config is accepted or safely migrated.
- Rollback/abort instructions tied to a known-good ref or artifact digest.
- Explicit statement that provider sends, Terminal Brief ACK, production DB mutations, source-public execution, and repository visibility changes were not performed.
- Exact PR/Done/Block URLs for sibling lanes before any aggregate GO claim.

## Recurrence prevention verification

- Add or refresh a CI test that fails when a config fixture includes a key missing from plugin `configSchema`.
- Include a negative fixture proving unknown properties still fail closed instead of silently passing.
- Keep the pre-restart checklist in the release/runbook path so restarts cannot bypass schema parity evidence.
- Refresh this libero matrix last, after sibling lanes publish terminal evidence, and preserve `NO-GO / Waiting` while any lane is Start-only or unmerged.

## Safe closeout

The safe closeout for a2a-plane#251 (a2a-plane#251, internal tracker private) is a validation PR/Done marker saying the config/schema skew prevention matrix is documented and tested, while any live restart, deploy, source-public execution, or approval execution remains **`NO-GO / Waiting`** until all sibling hardening evidence and explicit operator approval exist.
