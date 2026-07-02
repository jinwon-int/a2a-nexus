# Implementation Plan: A2A Terminal Brief parent-origin routing contract

## Linked spec

- Spec: `docs/specs/a2a-terminal-brief-parent-origin-routing/spec.md`
- Development tracker: `jinwon-int/a2a-broker#634`
- Spec-first adoption tracker: `a2a-plane#315 (internal tracker, private)`

## Size classification

- [ ] Small
- [ ] Medium
- [x] Large

Reason: the change spans broker metadata, plugin relay behavior, control-plane contracts, cross-broker Terminal Brief semantics, and future live canary validation. It involves at least three repos and cross-team routing.

## Affected repos/components

- `a2a-plane`: contract docs, fixtures, conformance/release-gate checks.
- `a2a-broker`: Terminal Brief metadata normalization, cross-broker projection ingest/store, terminal event outbox payload, parent existence guard tests.
- `openclaw-plugin-a2a`: cross-broker terminal relay projection builder, operator event bridge notification suppression/fallback tests.
- `a2a-docker-runner`: no expected runtime change; ensure runner output remains evidence fallback, not headline.
- worker/node config: no expected config change in source PRs; live activation remains separately approved.
- Wiki/runbooks: already updated with the four-case matrix; update again only if implementation changes operator procedure.

## Broker / worker / finalizer roles

- Broker of record / finalizer for implementation closeout: broker-beta unless explicitly handed off.
- Code workers:
  - broker lane for `a2a-broker` contract/tests;
  - plugin lane for `openclaw-plugin-a2a` relay/notification tests;
  - plane lane for `a2a-plane` contract/fixture/release gate.
- Libero/validator: validate cross-repo consistency and safety gates.
- Human approval owner: the operator for deploy/restart/live canary/DB/ACK/replay/release/secret operations.

## Execution lane

- [ ] Direct small change
- [ ] Isolated subagent
- [ ] Broker-owned TaskFlow
- [x] TaskFlow + A2A evidence workers, or equivalent detached multi-lane orchestration
- [ ] Other:

Why this lane is safe: the implementation is multi-repo and cross-broker. Heavy code review, test execution, and evidence collection should not run in the broker Telegram foreground session.

## Data/control flow

### Local same-team cases

1. broker-alpha -> Team1 only:
   - parent/origin broker: `broker-alpha`;
   - worker side: Team1;
   - Terminal Brief sender: broker-alpha;
   - no broker-beta parent seeding or relay.

2. broker-beta -> Team2 only:
   - parent/origin broker: `broker-beta`;
   - worker side: Team2;
   - Terminal Brief sender: broker-beta;
   - no broker-alpha parent seeding or relay.

### Cross-team cases

3. broker-alpha -> Team1+Team2:
   - parent/origin broker: `broker-alpha`;
   - Team2 child/handoff broker: broker-beta;
   - broker-beta relays Team2 child projections back to broker-alpha;
   - broker-alpha sends operator-facing Terminal Briefs.

4. broker-beta -> Team1+Team2:
   - parent/origin broker: `broker-beta`;
   - Team1 child/handoff broker: broker-alpha;
   - broker-alpha relays Team1 child projections back to broker-beta;
   - broker-beta sends operator-facing Terminal Briefs.

## Source PR order

### PR A — `a2a-plane` contract/fixture/release gate

Purpose: make the contract explicit before runtime changes.

Expected changes:

- add/update four-case routing fixture;
- document parent/origin vs handoff broker fields;
- encode default Terminal Brief title metadata for `A2A Terminal Brief 완료: worker(n/N)`;
- assert that the operator-facing sender is the initiating parent/origin broker, never a child/handoff broker;
- add release-gate/conformance coverage that rejects missing/ambiguous cases.

### PR B — `a2a-broker` routing contract/tests

Purpose: make broker-side metadata and projection behavior first-class.

Expected changes:

- add routing helper or equivalent normalized contract;
- normalize `teamScope`, parent/origin broker, handoff broker, parent round order/total;
- preserve `missing_parent` fail-closed behavior;
- add tests for all four cases.

### PR C — `openclaw-plugin-a2a` relay/notification tests

Purpose: make relay behavior match the parent-origin contract.

Expected changes:

- ensure projection builder emits unambiguous parent/origin and handoff fields;
- add relay-success duplicate suppression test;
- preserve relay-failure local fallback test;
- ensure synthetic parent-side projection rows do not relay back to child.

### PR D — optional follow-up enforcement

Purpose: only after PR A-C are stable, decide whether to add issue/PR template enforcement or TaskFlow automation.

## Tests and validation

- `a2a-plane`:
  - `npm run test:release-gate`
  - relevant conformance fixture tests, including default title metadata and parent/origin-only sender assertions
- `a2a-broker`:
  - focused tests for Terminal Brief metadata, cross-broker projection, terminal outbox, task events
  - full `npm test` before merge
- `openclaw-plugin-a2a`:
  - focused relay/bridge tests
  - full `npm test` before merge
- Live canary:
  - not part of source PRs;
  - requires separate approval;
  - should validate both broker-alpha-parent/broker-beta-child and broker-beta-parent/broker-alpha-child directions.

## Rollout plan

1. Merge docs/spec trial PR in `a2a-plane`.
2. Open PR A in `a2a-plane` for contract/fixture/release gate.
3. Open PR B in `a2a-broker` for broker routing contract.
4. Open PR C in `openclaw-plugin-a2a` for plugin relay/notification tests.
5. Rehearse source merge order after CI is green.
6. Request separate approval for deploy/restart/canary only after source is merged.

## Rollback plan

- Docs/spec PR: revert PR if the protocol framing is wrong.
- Source PRs: revert individual PRs in reverse merge order.
- Runtime activation: do not start until separately approved; if activation fails, disable relay window, remove allowlist, advance cursor only to prevent replay, and do not DB-prune or manually ACK without approval.

## Closeout evidence

Final closeout must include:

- all PR URLs and merge commits;
- tests and CI results;
- live canary decision if separately approved;
- explicit note that no DB/ACK/replay/release/secret action occurred unless approved;
- Wiki/runbook update link or explanation that no update was needed.
