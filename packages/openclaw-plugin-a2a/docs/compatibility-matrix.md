# Compatibility matrix for `plugin-a2a`

This document defines what "compatible" means between:

- `plugin-a2a`
- OpenClaw core / plugin SDK
- `a2a-broker`

Compatibility is not just a semver question. A release is considered compatible only when the plugin's expected OpenClaw seams, broker wire contract, and broker schema assumptions all hold at the same time.

## 1. Compatibility dimensions

Every published compatibility entry should include these dimensions.

### 1.1 Plugin release

The plugin version range being described.

Example:

- `0.1.x`
- `0.2.x`

### 1.2 OpenClaw baseline

The minimum OpenClaw baseline the plugin expects.

This should be written in terms of **available plugin-SDK seams**, not just a vague app version, because the extraction work is seam-driven.

Relevant seams:

- sessions-send delegation hook
- wait-run handle seam
- cancel fan-out seam
- heartbeat / timeout timer seam
- gateway runtime contract used by this plugin

### 1.3 Broker release

The supported `a2a-broker` version range.

Example:

- `0.1.x`
- `>=0.2.0 <0.3.0`

### 1.4 Broker schema / contract baseline

The plugin should publish the broker schema baseline it assumes.

Current documented baseline:

- snapshot schema `5`

This matters because the broker's HTTP surface and payload expectations are part of the compatibility contract even when storage is an internal concern.

### 1.5 Release-note requirement

Each matrix row should say whether the upgrade is:

- compatible with no operator action
- compatible with documented migration steps
- coordinated upgrade required
- incompatible

## 2. What “compatible” means

A release should be marked **compatible** only if all of the following remain true.

### 2.1 Broker auth / header contract matches

The plugin and broker must agree on the meaning and presence of:

- `x-a2a-edge-secret`
- `x-a2a-requester-id`
- `x-a2a-requester-kind`
- `x-a2a-requester-role`

If header names or enforcement semantics drift, the release is not compatible without a coordinated update.

### 2.2 Broker task status vocabulary matches

The plugin currently expects the broker task lifecycle vocabulary:

- `queued`
- `claimed`
- `running`
- `succeeded`
- `failed`
- `canceled`

If the broker adds or changes status values, the plugin-side mapping must be updated before that broker version is declared compatible.

### 2.3 Broker error envelope matches

The plugin expects the broker error shape:

```json
{
  "error": {
    "code": "optional",
    "message": "optional",
    "details": {}
  }
}
```

Any breaking change to this envelope is plugin-visible and must be treated as a compatibility boundary.

### 2.4 Payload carry-through still holds

The plugin depends on the broker preserving payload keys verbatim for round-trip reads.

Current fields to preserve:

- `requesterSessionKey`
- `requesterChannel`
- `targetSessionKey`
- `targetDisplayKey`
- `correlationId`
- `parentRunId`

If the broker normalizes, renames, or drops any of these, compatibility is broken.

### 2.5 Required OpenClaw seams exist

The plugin's compatibility with OpenClaw is defined by the seam set it needs.

In the current extraction plan, the critical seams are:

- sessions-send delegation hook
- wait-run handle seam
- cancel fan-out seam
- heartbeat / timeout timer seam

If a plugin release assumes these seams but the target OpenClaw build does not expose them, that build is not compatible even if version labels look close.

### 2.6 Broker protocol profile contract

The plugin extracts the broker-advertised A2A protocol profile from the broker
health endpoint's `protocol` block and surfaces it through `a2a.monitor.status`
diagnostics as `brokerProtocolProfile`.

Contract expectations:

- **`protocol.protocolVersion`** — the A2A protocol version the broker advertises
  (for example `"1.0"`, `"0.3"`). The plugin falls back to `protocol.version`
  and `protocol.target` when `protocolVersion` is absent.
- **`protocol.capabilities.streaming`** — boolean indicating SSE streaming support.
  Absent or `false` means streaming is unavailable.
- **`protocol.capabilities.pushNotifications`** — boolean indicating A2A push
  notification support. `false` is the expected value for standard broker
  deployments; the plugin surfaces this explicitly so operators can distinguish
  Terminal Brief/outbox ACK from A2A push notification conformance.
- **`protocol.inputModes`** and **`protocol.outputModes`** — string arrays
  describing supported media types (for example `["text/plain","application/json"]`).
- **`protocol.transportHints`** — object indicating support status for specific
  transports (`"rest"`, `"grpc"`, `"push"`). Each value must be one of
  `"supported"`, `"unsupported"`, or `"deferred"`.

Compatibility rules:

1. The `protocol` block is optional. Its absence does not degrade diagnostics.
2. The plugin reads the protocol block from the same health endpoint it already
   calls; no additional endpoint or AgentCard fetch is required.
3. Provider accepted/message-id evidence remains send-acceptance telemetry and
   is not operator-visible ACK. Terminal Brief/outbox boundaries are distinct
   from A2A push notification conformance.
4. If the broker changes the protocol block shape in a way that drops or renames
   fields the plugin expects, the `brokerProtocolProfile` output will omit those
   fields gracefully.

## 3. Proposed published matrix format

Each published row should include:

- plugin version range
- OpenClaw baseline
- required SDK seams
- broker version range
- broker schema version(s)
- compatibility level
- operator notes / migration action

Suggested table shape:

| Plugin | OpenClaw baseline | Required seams | Broker | Broker schema | Compatibility | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `0.1.x` | pre-independent-cut extraction window | current gateway runtime, plus in-core delegated runtime assumptions | `0.1.x` | `5` | conditional | migration target, not yet a fully independent plugin line |
| `0.2.x` | first seam-complete OpenClaw baseline | sessions-send hook, wait-run, cancel fan-out, timer seam | pinned supported range | `5` or later documented range | coordinated | first candidate for split-ready independent support |

## 4. Initial matrix recommendation

Until the extraction stabilizes, the matrix should start **narrow**, not broad.

Recommended first published stance:

- plugin: `0.1.x`
- broker: `0.1.x`
- broker schema: `5`
- OpenClaw baseline: document the exact seam state expected
- compatibility label: **conditional / coordinated**, not “widely compatible”

For public/stable readiness checks, also require the public-safe configuration and notification defaults in [`public-stable-readiness.md`](./public-stable-readiness.md): example broker URLs and notification targets must remain placeholders, `operatorEvents.notification.enabled` must stay disabled unless explicitly approved by an operator, and provider/Gateway send acceptance must not be documented as a terminal-outbox ACK.

Reason:

At this stage the main source of compatibility risk is not ordinary semver churn. It is the extraction boundary between OpenClaw core ownership and plugin ownership. Publishing a broad range too early would imply a stronger guarantee than the code and docs actually support.

## 5. Coordinated-release triggers

The following changes should always force a compatibility-matrix review and a release-note update.

### 5.1 Broker status vocabulary changes

Any new broker task status or status semantic shift.

### 5.2 Broker timeout / error-code vocabulary changes

The plugin's timeout mapping depends on broker error-code semantics. Drift here can silently change `failed` vs `timed_out` behavior.

### 5.3 Header or auth contract changes

Any rename or semantic change to edge-secret or requester headers.

### 5.4 Payload field changes

Any change to the carry-through fields used to correlate task state back into OpenClaw.

### 5.5 Request translation changes

Any change to how plugin-side gateway requests translate into broker task requests.

### 5.6 Plugin identity changes

If `a2a-broker-adapter` is renamed, that must be documented as a compatibility event even if the wire contract stays stable.

### 5.7 Delegated-task runtime ownership changes

The point where delegated-task runtime moves fully out of OpenClaw core and into the plugin is a compatibility boundary and should be called out explicitly.

## 6. Release-note language templates

### 6.1 Additive, no broker migration required

> This release remains compatible with `a2a-broker` schema v5 and does not require a broker-side migration.

### 6.2 OpenClaw seam baseline required

> This release requires an OpenClaw build that includes the delegated-task plugin SDK seams: sessions-send hook, wait-run handle, cancel fan-out, and timer seam.

### 6.3 Coordinated broker change required

> This release changes the broker contract and must be paired with a documented supported `a2a-broker` version from the compatibility matrix.

### 6.4 Conditional compatibility during extraction

> This release is compatible only within the documented extraction window and should be treated as a migration-target plugin line rather than a fully independent cut.

## 7. Suggested publication plan

1. Add this document as `docs/compatibility-matrix.md`
2. Link it from `README.md`
3. Keep `docs/migration-plan.md` focused on extraction work
4. Use the matrix doc as the canonical place for:
   - supported broker ranges
   - required OpenClaw seam baselines
   - coordinated release triggers
   - release-note wording

## 8. Current editorial recommendation

For the first published version of this doc:

- prefer exact or narrow supported ranges
- explicitly distinguish “migration target” from “independently supportable plugin”
- treat seam availability as a first-class compatibility rule
- avoid claiming stable broad compatibility until the delegated-task runtime extraction is complete
