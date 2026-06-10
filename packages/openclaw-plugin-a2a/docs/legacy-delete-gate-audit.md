# Legacy delete-gate audit

Closes the analysis half of plugin-a2a#12 and feeds parent #6.

## Scope

Issue #12 asked for a parity checklist against the archived legacy repo areas:

- `src/broker.ts`
- `src/status.ts`
- `src/store.ts`
- `integrations/openclaw/`

The archived repo itself is not currently available from the active remotes used in this workspace, so this audit is based on:

- the explicit delete criteria in parent #6
- the active `a2a-broker` codebase
- the active `plugin-a2a` codebase
- the migration and regression docs already written in this repo

That means this document is reliable for **active-owner mapping and remaining delete blockers**, but not yet a line-by-line code tombstone for the archived tree.

## Parity checklist by ownership

### 1. Legacy broker/runtime ownership

Now owned by `a2a-broker`:

- task lifecycle state machine
- worker registration / heartbeat / stale detection
- stale requeue and dead-letter policy
- broker persistence / state snapshot handling
- dashboard / health / audit surfaces
- A2A facade and SSE task subscription

Evidence:

- `a2a-broker/src/core/broker.ts`
- `a2a-broker/src/core/store.ts`
- `a2a-broker/src/server.ts`
- `a2a-broker/docs/restart-recovery-smoke.md`
- `a2a-broker/docs/a2a-broker-audit-remediation-20260417.md`

### 2. Legacy OpenClaw integration ownership

Now owned by `plugin-a2a`:

- broker client configuration and activation gate
- gateway `a2a.task.request | update | cancel | status`
- broker/OpenClaw status mapping
- plugin-local request validation and error shaping
- broker payload round-trip decoding for requester/target/run metadata

Evidence:

- `plugin-a2a/config.ts`
- `plugin-a2a/standalone-broker-client.ts`
- `plugin-a2a/src/gateway-handlers.ts`
- `plugin-a2a/src/gateway-schema.ts`
- `plugin-a2a/type-mapping.ts`

### 3. Legacy semantics that still depend on OpenClaw core

Still not fully extracted:

- delegated-send dispatch decision inside `sessions_send`
- wait-run registration and resolution
- ping-pong turn loop
- timeout / heartbeat watchdog for delegated sends
- cancel fan-out between broker tasks and OpenClaw session runs

Evidence:

- `plugin-a2a/docs/migration-plan.md` §1, §2, §3
- `plugin-a2a/docs/regression-matrix.md`

## Concrete delete blockers for parent #6

Parent #6 says the legacy repo can only be deleted when all of these are true:

### Blocker A. `sessions_send` delegated runtime still lives in core

Status: **open**

Why it blocks deletion:
- this is the last major piece of legacy OpenClaw integration behavior not fully owned by the plugin
- deleting the legacy repo before this finishes would leave the extraction story incomplete and make parity harder to prove

Active tracking:
- plugin #7 for the dispatch-flip contract
- follow-up core seam issues from `docs/migration-plan.md`

### Blocker B. Required plugin SDK seams are not all landed

Status: **open**

Needed seams:
- sessions-send delegation hook
- wait-run handle seam
- cancel fan-out seam
- heartbeat / timeout timer seam

Why it blocks deletion:
- without these seams, the plugin cannot become the sole owner of delegated-send runtime behavior

### Blocker C. Archived-only semantics are not yet fully tombstoned

Status: **partially open**

What is already clear:
- active broker ownership exists
- active plugin ownership exists
- remaining extraction gap is documented

What is still missing:
- a final archived-repo-to-active-repo tombstone table once the archived source is available through a recoverable remote, bundle, or exported snapshot

Why it blocks deletion:
- parent #6 explicitly requires that no unique code or docs remain only in the archived repo
- we have high confidence on the runtime split, but not yet a direct archived-source inventory artifact

## Recommendation: what must land before #6 closes

Minimum set:

1. land the plugin SDK seams described in `docs/migration-plan.md`
2. complete the plugin-owned dispatch flip described in `docs/sessions-send-hook-contract.md`
3. move the remaining delegated runtime out of core
4. run the regression matrix rows that prove direct send vs delegated send still route correctly
5. produce a final archived-source tombstone checklist if the archived repo becomes accessible again

## Suggested parent #6 checklist wording

- [ ] sessions-send delegated dispatch moved behind plugin-owned hook
- [ ] wait-run / cancel / timeout seams landed in core plugin SDK
- [ ] delegated-task runtime moved out of core and into plugin-owned path
- [ ] regression matrix covers direct-send vs delegated-send routing after the flip
- [ ] archived repo leaves no unique code or docs without an active owner

## Current conclusion

The legacy repo should **not** be deleted yet.

The active-owner split is mostly clear:
- broker domain logic → `a2a-broker`
- OpenClaw adapter/plugin logic → `plugin-a2a`

But parent #6 remains blocked by the still-core-owned delegated-send runtime and by the lack of a final archived-source tombstone artifact.
