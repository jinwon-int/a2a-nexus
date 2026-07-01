# Team2 Libero config schema parity validation

Parent: a2a-plane#249 (a2a-plane#249, internal tracker private)
Incident reference: [openclaw-plugin-a2a#271](https://github.com/jinwon-int/openclaw-plugin-a2a/pull/271)
Round ID: `a2a-config-schema-skew-prevention-20260511T120400Z`

## Libero verdict

Decision: `NO-GO / Waiting` until every plugin configuration change proves schema/runtime parity before any Gateway restart or deploy.

This validation lane is source-only. It does not restart Gateway, deploy services, send Telegram/provider messages, mutate databases, rotate secrets, force-push, or change repository visibility.

## Required parity gates

| Gate | Required evidence | Fail-closed condition |
| --- | --- | --- |
| Manifest/runtime parity | Every runtime-accepted plugin config path has a matching `openclaw.plugin.json` `configSchema` entry before merge. | Any runtime fixture path is absent from the manifest schema. |
| Restart fixture | CI validates a representative restart-safe config fixture against the manifest schema. | The fixture would be rejected with `additionalProperties` or type errors. |
| Cross-broker skew guard | `operatorEvents.crossBrokers[]` is registered with `baseUrl`, `edgeSecret`, and `label` because this was the incident shape. | `operatorEvents.crossBrokers` is missing or accepts unconstrained item properties. |
| Pre-restart check | Operators run schema validation and `openclaw status` before `systemctl restart` or equivalent service restart. | Validation is skipped, stale, or based only on human review. |
| Runner pre-deploy check | Docker runner/deploy automation validates plugin config against the manifest schema before terminal evidence or rollout. | Runner creates Done/PR evidence while the restart fixture would fail. |

## Current patch evidence

- `packages/openclaw-plugin-a2a/openclaw.plugin.json` registers `operatorEvents.crossBrokers[]` under `operatorEvents` while preserving `additionalProperties: false`.
- `packages/openclaw-plugin-a2a/test/openclaw-plugin-config-schema.test.mjs` validates the incident-shaped restart fixture and rejects unknown cross-broker item fields.
- `scripts/archive/check-team2-config-schema-parity-libero.test.mjs` pins this document and the manifest/schema shape in the root release gate.

## Runtime/bootstrap fail-closed rule

Before PR or terminal evidence, fail closed if any changed or untracked repo path matches: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`. Report exact repo-relative offending paths. Do not include raw session dumps or OpenClaw runtime context in branch artifacts.
