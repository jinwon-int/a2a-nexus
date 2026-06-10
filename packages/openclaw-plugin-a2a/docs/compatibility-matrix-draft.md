# Compatibility matrix draft

Drafted for `jinwon-int/plugin-a2a#9`.

## Why this doc exists

For this plugin, "compatible" cannot mean only "it installs".

Compatibility here means:

1. the plugin can load against the target `openclaw` plugin SDK surface
2. the plugin can speak to the target `a2a-broker` wire contract without translation drift
3. lifecycle, error, auth, and payload round-trip behavior remain stable enough for operators to diagnose failures

That means the published matrix needs both **version ranges** and the **contract surfaces whose drift breaks those ranges**.

## Recommended published matrix shape

Each plugin release should publish a table like this.

| Plugin release | Supported OpenClaw / plugin-SDK range | Supported a2a-broker range | Contract generation | Notes |
| --- | --- | --- | --- | --- |
| `0.1.x` | `TBD once seams land` | `TBD once broker cut is pinned` | `v1` | Initial standalone compatibility line |

This table should live in two places:

- `README.md` quick operator view
- release notes / changelog entry with any narrower caveats

## What contract generation means

Use a human-readable contract generation label, for example `v1`, to group the shared wire expectations that must move together.

That generation covers the aligned surfaces already identified in `docs/migration-plan.md` section 4.

## Coordinated-release contract surfaces

A plugin release and a broker release must be coordinated when any of these change.

### 1. Party ref vocabulary

Shared shape:

- `{ id, kind?, role? }`
- `kind ∈ session | node | user | service`
- `role ∈ hub | live-trader | researcher | analyst | operator`

If broker adds or removes a `kind` or `role`, plugin schema and validators must ship in step.

### 2. Broker task status vocabulary

Shared broker status set:

- `queued`
- `claimed`
- `running`
- `succeeded`
- `failed`
- `canceled`

Plugin translation depends on `type-mapping.ts`. Any new broker status is a coordinated release item.

### 3. Broker task intent vocabulary

Shared broker intent set:

- `chat`
- `analyze`
- `backfill`
- `propose_patch`
- `propose_params`
- `validate_change`
- `apply_local_change`
- `promote_to_live`
- `rollback_live`

Important: gateway `task.intent` is intentionally a different enum. Compatibility means the translation layer remains correct, not that the enums match directly.

### 4. SSE event and reason vocabulary

Shared event names:

- `task-snapshot`
- `task-status-update`

Shared status-update reasons:

- `created`
- `claimed`
- `started`
- `succeeded`
- `failed`
- `canceled`
- `reassigned`
- `requeued`
- `dead_lettered`

Snapshot reason:

- `snapshot`

Changes here affect both lifecycle interpretation and regression coverage.

### 5. Error envelope

Shared shape:

```json
{
  "error": {
    "code": "...",
    "message": "...",
    "details": {}
  }
}
```

`buildClientError` and gateway error shaping depend on this remaining stable.

### 6. Edge-auth headers

Shared headers:

- `x-a2a-edge-secret`
- `x-a2a-requester-id`
- `x-a2a-requester-kind`
- `x-a2a-requester-role`

Rename or semantics change here is compatibility-significant.

### 7. Payload carry-through fields

The plugin currently depends on broker round-tripping these payload keys verbatim:

- `requesterSessionKey`
- `requesterChannel`
- `targetSessionKey`
- `targetDisplayKey`
- `correlationId`
- `parentRunId`

If the broker normalizes, strips, or renames any of these, compatibility is broken even if the request still succeeds.

## Recommended release-note language

Each plugin release note should include a short block like:

> **Compatibility**
> - Supports OpenClaw plugin-SDK range: `...`
> - Supports `a2a-broker` range: `...`
> - Contract generation: `v1`
> - Coordinated release required if broker/task status vocabulary, SSE reasons, auth headers, or payload round-trip fields change.

## Operator-facing compatibility checks

The matrix should not stop at versions. It should tell operators what to verify when behavior looks wrong.

| Symptom | Likely compatibility drift | First check |
| --- | --- | --- |
| timeout shows up as generic failed | timeout code mapping drift | `type-mapping.ts` vs broker `error.code` |
| task updates fail after requeue | worker-id / SSE reason handling drift | claimedBy handling and SSE reasons |
| auth suddenly fails after upgrade | edge-header contract drift | requester headers + broker auth config |
| task status loads but context is missing | payload carry-through drift | six preserved payload keys |
| plugin builds but runtime handlers fail | OpenClaw/plugin-SDK seam drift | imported `openclaw/plugin-sdk/*` surfaces |

## Suggested initial policy

Until real release cadence exists, publish the first matrix with conservative language:

- support only the broker versions tested in CI or smoke validation
- support only the OpenClaw/plugin-SDK range explicitly exercised by this repo
- do not imply wildcard compatibility just because `peerDependencies.openclaw = "*"`

## Recommended documentation layout

### README

Keep only the compact table plus one sentence defining compatibility.

### docs/compatibility-matrix.md

Keep:

- version table
- contract generation definition
- coordinated-release surfaces
- operator symptom mapping
- link to `docs/regression-matrix.md`

### Release notes

Record any narrowing or widening of supported ranges and call out which contract surface changed.

## Done means

This issue should count as done when:

- we define exactly what compatibility means for this plugin
- we publish a matrix shape that future releases can reuse
- we identify the contract surfaces that trigger coordinated broker/plugin releases
- release note wording exists in near-copy-paste form
