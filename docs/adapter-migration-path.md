# A2A Adapter Migration Path: OpenClaw-Only to Platform-Independent

> **v0 Draft (2026-05-28):** This document defines the phased migration path from OpenClaw-only
> A2A adapters to a platform-independent adapter model. It is a companion to the
> [Platform-Independent A2A Adapter Interface Contract](../contracts/a2a/platform-adapter-interface.md).
>
> **Status:** Migration plan only. No adapter implementation, provider send, Gateway restart,
> terminal-outbox ACK, DB mutation, or any prohibited action is authorized by this document.
>
> **Lane issue:** [a2a-plane#475](https://github.com/jinwon-int/a2a-plane/issues/475)
> **Parent:** [a2a-plane#500](https://github.com/jinwon-int/a2a-plane/issues/500)

---

## Current State

All A2A broker-facing adapters are tightly coupled to the OpenClaw Gateway and plugin SDK:

| Adapter | Location | Dependency |
| --- | --- | --- |
| Runtime Wake Adapter | `packages/openclaw-plugin-a2a/src/runtime-wake-adapter.ts` | OpenClaw session runtime |
| Durable Session Wake Adapter | `packages/openclaw-plugin-a2a/src/durable-session-wake-adapter.ts` | OpenClaw session runtime |
| Status Result Delivery Adapter | `packages/openclaw-plugin-a2a/src/status-result-delivery-adapter.ts` | OpenClaw payload delivery bridge |
| Operator Notification Adapter | `packages/openclaw-plugin-a2a/src/operator-notification-adapter.ts` | OpenClaw channel adapter |
| Recovery Action Adapter | `packages/openclaw-plugin-a2a/src/recovery-action-adapter.ts` | OpenClaw session runtime |
| Remote Node Handoff Adapter | `packages/openclaw-plugin-a2a/src/remote-node-handoff-adapter.ts` | OpenClaw node resolver |
| Payload Delivery Bridge | `packages/openclaw-plugin-a2a/src/payload-delivery-bridge.ts` | OpenClaw delegation flow |
| Operator Event Bridge | `packages/openclaw-plugin-a2a/src/operator-event-bridge.ts` | OpenClaw monitoring surface |
| Gateway Handlers | `packages/openclaw-plugin-a2a/src/gateway-handlers.ts` | OpenClaw plugin SDK |

Hermes workers bypass this with poll-mode scripts (`docs/specs/hermes-worker-integration/`),
creating two parallel maintenance surfaces.

---

## Phase 1: Interface Definition + OpenClaw Adapter Refactoring

**Scope:** Define the abstract interface; wrap existing OpenClaw adapters behind it.

### Steps

1. **Land the interface contract.**
   - `contracts/a2a/platform-adapter-interface.md` defines the abstract `A2AAdapter` interface.
   - `fixtures/contract/platform-adapter-interface.json` provides machine-readable conformance.
   - Both are source-only; no runtime behavior changes.

2. **Wrap existing adapters behind `A2AAdapter`.**
   Each existing OpenClaw adapter gets a thin wrapper that implements `A2AAdapter` while delegating
   to the existing OpenClaw-specific implementation. This proves the interface can represent the
   existing behavior without rewriting it.

   | Existing adapter | Wrapper location (new) | Notes |
   | --- | --- | --- |
   | `runtime-wake-adapter.ts` | `adapters/runtime-wake-adapter.ts` | Implements `onWake` for wake dispatch |
   | `operator-notification-adapter.ts` | `adapters/operator-notification-adapter.ts` | Implements `submitEvidence` for notification delivery |
   | `status-result-delivery-adapter.ts` | `adapters/status-result-delivery-adapter.ts` | Implements `reportStatus` bridge |
   | `recovery-action-adapter.ts` | `adapters/recovery-action-adapter.ts` | Implements checkpoint/resume |

   Each wrapper is verified against the conformance fixture.

3. **Add conformance test.**
   `test/conformance/check-platform-adapter-interface.mjs` validates the fixture and the wrappers.

4. **Document adapter registration.**
   Update `docs/ecosystem-guide.md` with the new abstract interface and how non-OpenClaw platforms
   can implement it.

### Exit criteria

- [x] Interface contract document published.
- [x] Fixture published.
- [ ] All OpenClaw adapters have conformance-verified wrappers.
- [ ] Conformance test passes for wrappers.
- [ ] Ecosystem guide updated.

### Size estimate

| Item | Effort |
| --- | --- |
| Interface contract + fixture | ~1 day |
| OpenClaw adapter wrappers (4 adapters) | ~3 days |
| Conformance test | ~1 day |
| Ecosystem guide update | ~0.5 day |

---

## Phase 2: Hermes Native Adapter

**Scope:** Implement a Hermes-native adapter that uses the abstract interface, replacing the
poll-mode script.

### Motivation

The current Hermes worker integration (`docs/specs/hermes-worker-integration/`) uses HTTP polling.
A native Hermes adapter would:

- Use the same `A2AAdapter` interface as OpenClaw adapters
- Support SSE push for real-time task events (when broker supports it)
- Eliminate the separate poll-mode maintenance path
- Pass the same conformance fixture as OpenClaw adapters

### Steps

1. **Implement `HermesA2AAdapter`.**
   A TypeScript (or Hermes-compatible) class that implements `A2AAdapter` and communicates with
   the broker via the standard worker API (`POST /workers/register`, `POST /workers/:id/heartbeat`,
   `GET /tasks?worker=...`, `POST /tasks/:id/claim`, `POST /tasks/:id/evidence`).

2. **Add Hermes-specific transport.**
   SSE push subscription for real-time task creation events, falling back to HTTP-poll when SSE
   is unavailable.

3. **Pass conformance fixture.**
   The Hermes adapter must pass the same `platform-adapter-interface.json` fixture as OpenClaw
   adapters.

4. **Update Hermes documentation.**
   Replace the poll-mode reference in `docs/specs/hermes-worker-integration/` with the native
   adapter path.

### Exit criteria

- [ ] `HermesA2AAdapter` implemented.
- [ ] Hermes adapter passes conformance fixture.
- [ ] Hermes documentation updated.

### Size estimate

| Item | Effort |
| --- | --- |
| Hermes adapter implementation | ~3 days |
| SSE transport support | ~2 days |
| Conformance fixture update | ~1 day |
| Docs update | ~0.5 day |

---

## Phase 3: CLI / Minimal Adapter Reference Implementation

**Scope:** Implement a minimal CLI adapter that demonstrates `A2AAdapter` with `curl`/`wget`-based
HTTP calls. This serves as a reference for non-JS platforms.

### Motivation

A minimal CLI adapter proves that the interface is truly platform-independent — if it can be
implemented with shell scripts and curl, any language can implement it.

### Steps

1. **Implement CLI adapter.**
   A shell script (`adapters/cli/minimal-adapter.sh`) that:
   - Polls the broker for pending tasks (`GET /tasks?worker=...&status=pending`)
   - Claims a task (`POST /tasks/:id/claim`)
   - Executes a provided command with the task input
   - Submits evidence (`POST /tasks/:id/evidence`)
   - Sends heartbeats (`POST /workers/:id/heartbeat`)

2. **Document the CLI adapter.**
   `docs/external-harness-quickstart.md` is the natural home.

3. **Reference implementation in Python.**
   A minimal Python adapter (`adapters/cli/python-a2a-adapter.py`) that uses only stdlib
   (`urllib.request`) to demonstrate the interface without external dependencies.

### Exit criteria

- [ ] Shell-based CLI adapter works against a test broker.
- [ ] Python reference implementation works.
- [ ] Documentation demonstrates both.

### Size estimate

| Item | Effort |
| --- | --- |
| Shell CLI adapter | ~1 day |
| Python reference adapter | ~2 days |
| Documentation | ~1 day |

---

## Phase 4: Documentation, Validation, and Deprecation

**Scope:** Fill documentation gaps, run cross-platform conformance validation, and mark
OpenClaw-only adapter paths as legacy.

### Steps

1. **Update ecosystem guide.**
   Add a "Writing an A2A Adapter" section to `docs/ecosystem-guide.md` that walks through the
   interface contract, the conformance fixture, and the four transport modes.

2. **Update OpenClaw plugin README.**
   `packages/openclaw-plugin-a2a/README.md` gets a "Migration Status" section showing which
   adapters have been wrapped behind the abstract interface.

3. **Cross-platform conformance matrix.**
   Test the conformance fixture against:
   - OpenClaw adapters (via wrappers)
   - Hermes adapter (if Phase 2 is complete)
   - CLI adapter (if Phase 3 is complete)

4. **Deprecate direct OpenClaw adapter exports.**
   Mark the old adapter types in `packages/openclaw-plugin-a2a/` as `@deprecated` with a note
   pointing to the abstract interface equivalents.

### Exit criteria

- [ ] Ecosystem guide has "Writing an A2A Adapter" section.
- [ ] Cross-platform conformance matrix published.
- [ ] Old adapters marked as deprecated.

### Size estimate

| Item | Effort |
| --- | --- |
| Documentation updates | ~1 day |
| Cross-platform conformance | ~1 day |
| Deprecation markers | ~0.5 day |

---

## Dependency Graph

```
Phase 1 (Interface + wrappers)
  │
  ├──► Phase 2 (Hermes adapter)
  │       │
  │       └──► Phase 4 (Documentation, validation, deprecation)
  │
  └──► Phase 3 (CLI adapter)
          │
          └──► Phase 4
```

Phases 2 and 3 can proceed in parallel after Phase 1 completes.

---

## Safety Gates (All Phases)

| Gate | Applies to | Rule |
| --- | --- | --- |
| No production deploy | All phases | All changes are source-only until explicit operator approval |
| No Gateway restart | All phases | No Gateway/broker/worker restart or reload |
| No live provider send | All phases | Provider accepted-send evidence is send-acceptance only |
| No terminal-outbox ACK | All phases | No mutation of terminal-outbox ACK rows |
| No DB mutation | All phases | No production database read/write/prune/migrate |
| No secret movement | All phases | All evidence is redacted; no tokens, paths, or raw state |
| No approval | All phases | `isApproval: false` on all evidence |
| Runtime/bootstrap hygiene | Phase 1 document | No OpenClaw workspace files in branch |
| Hermes poll-mode left intact | Phase 2 | Old poll-mode is not deleted until deprecated in Phase 4 |

---

## Related Documents

- [Platform-Independent A2A Adapter Interface Contract](../contracts/a2a/platform-adapter-interface.md) — the abstract interface contract
- [OpenClaw-Core Extraction Plan](../packages/openclaw-plugin-a2a/docs/migration-plan.md) — OpenClaw plugin extraction from core
- [Hermes Worker Integration Spec](specs/hermes-worker-integration/spec.md) — existing Hermes HTTP-poll worker contract
- [Broker Handoff Protocol Contract](../contracts/a2a/broker-handoff-protocol.md) — broker-to-broker task handoff
- [A2A Ecosystem Guide](ecosystem-guide.md) — A2A Plane ecosystem documentation
