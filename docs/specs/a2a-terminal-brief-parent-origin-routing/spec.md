# Feature Spec: A2A Terminal Brief parent-origin routing contract

## Problem

A2A Terminal Brief work has taken too many ad-hoc rounds because parent/origin ownership, local-vs-cross-team behavior, and child projection rules are not expressed as one clear implementation contract.

The operator-facing requirement is not “any cross-broker Terminal Brief.” The required behavior is **parent-seeded Terminal Brief routing**:

- the broker that initiates the work owns the parent round;
- the initiating broker is both parent and origin for operator-facing default Terminal Brief notifications;
- that initiating broker is the only operator-facing Terminal Brief sender;
- the default completed-worker title is `A2A Terminal Brief 완료: worker(n/N)`, rendered from worker id, completed order, and parent round total metadata;
- same-team work stays local;
- cross-team work uses the opposite broker only as a child/handoff broker that relays projections back to the initiating parent broker.

The current live gates proved pieces of this behavior, but the code/test/docs still allow confusion such as ordinary Team2-only work being discussed as if broker-alpha should be involved.

## User / operator stories

- As an operator, when I tell broker-alpha to use Team1, I want broker-alpha to own the parent round and send the Terminal Brief without involving broker-beta.
- As an operator, when I tell broker-alpha to use Team1+Team2, I want broker-alpha to own the parent round while broker-beta relays Team2 child projections back to broker-alpha.
- As an operator, when I tell broker-beta to use Team2, I want broker-beta to own the parent round and send the Terminal Brief without involving broker-alpha.
- As an operator, when I tell broker-beta to use Team1+Team2, I want broker-beta to own the parent round while broker-alpha relays Team1 child projections back to broker-beta.
- As a broker/finalizer, I want exactly one parent/origin broker and one operator-facing Terminal Brief sender per round.
- As a worker, I want my output to become a bounded evidence packet without causing duplicate operator notifications.

## Routing cases

| Case | Initiator | Requested scope | Parent/origin broker | Execution path | Operator-facing Terminal Brief sender |
|---|---|---|---|---|---|
| 1 | broker-alpha | Team1 only | `broker-alpha` | Team1 local | broker-alpha |
| 2 | broker-alpha | Team1 + Team2 | `broker-alpha` | Team1 local + Team2 child/handoff through broker-beta | broker-alpha |
| 3 | broker-beta | Team2 only | `broker-beta` | Team2 local | broker-beta |
| 4 | broker-beta | Team1 + Team2 | `broker-beta` | Team2 local + Team1 child/handoff through broker-alpha | broker-beta |

Invariant:

> The initiating broker is the parent/origin broker and the only operator-facing Terminal Brief sender. Completed-worker notifications with known totals use `A2A Terminal Brief 완료: <worker>(<n>/<N>)`.

## Scope

### In scope

- Define the broker/runtime contract for the four routing cases.
- Make same-team work local-only by default.
- Make cross-team work parent-seeded and projection-based.
- Require parent existence before accepting a cross-team child projection.
- Preserve relay-success duplicate suppression and relay-failure local fallback.
- Define test and evidence requirements across `a2a-broker`, `openclaw-plugin-a2a`, and `a2a-plane`.
- Keep Terminal Brief title format concise and default to the operator-requested form: `A2A Terminal Brief 완료: <worker>(<n>/<N>)` (`A2A Terminal Brief 완료: worker(n/N)` as the placeholder).

### Out of scope

- Production deploy/restart/canary without separate approval.
- DB mutation/prune/migration/replay.
- Manual Terminal Brief ACK/replay.
- Release/tag publication.
- Secret movement/output.
- Replacing A2A broker/worker runtime architecture.
- Adopting the full GitHub Spec Kit CLI or slash-command set in this step.

## Success criteria

- [ ] Four-case routing helper or equivalent contract exists in code.
- [ ] Broker tests cover all four cases.
- [ ] Team2-only work cannot accidentally route through broker-alpha.
- [ ] Team1-only work cannot accidentally route through broker-beta.
- [ ] Cross-team child projections require an existing parent round on the initiating broker.
- [ ] Plugin tests prove relay success suppresses duplicate child local notification.
- [ ] Plugin tests prove relay failure falls back to local operator notification.
- [ ] Plane contract/fixtures/release gate cover the four routing cases.
- [ ] Plane conformance enforces title metadata for `A2A Terminal Brief 완료: worker(n/N)` and rejects child/handoff operator-facing ownership.
- [ ] Runner/internal output remains evidence fallback, not the Terminal Brief headline.
- [ ] Wiki/runbook stays aligned with implementation.

## Safety and approval boundaries

### Secrets and private data

The change touches A2A broker/plugin/runner/control-plane semantics. It must not expose:

- edge secrets;
- bot tokens;
- provider credentials;
- private hostnames/paths;
- Telegram IDs beyond already-approved operator-facing context;
- raw session dumps;
- production DB/outbox contents.

Use synthetic fixtures and redacted evidence only.

### Human approval required for

- [x] production deploy
- [x] Gateway/broker/worker/service restart
- [x] live canary/provider send
- [x] DB mutation/prune/migration/replay
- [x] manual Terminal Brief ACK/replay
- [x] release/tag
- [x] secret rotation/movement
- [x] force push/history rewrite

This spec does not approve any of the above.

### Broker foreground liveness

Implementation and validation work should not run as a long Telegram foreground session. Medium/large implementation rounds should use subagents, TaskFlow, or A2A evidence workers, with the broker/finalizer only coordinating and reporting.

## Evidence contract

Each implementation PR or worker packet must include:

- repo/branch/PR URL;
- affected files/functions;
- tests run and results;
- CI status;
- how the four cases are covered;
- title metadata proof: status label `완료`, worker id, completed order `n`, total `N`, and the parent/origin sender;
- safety actions explicitly not performed;
- remaining blockers or follow-up issues.

## Rollback / failure handling

- Source changes must be revertible by PR revert.
- Runtime activation must not occur until separately approved.
- Failed canaries must clean up temporary relay windows, cursors, and allowlists without DB pruning or manual ACK replay.
- Parentless projection rejection remains a correct fail-closed state, not a rollback trigger.

## Wiki/runbook follow-up

Family Wiki already records the four-case matrix. After implementation, update the relevant runbook if field names, activation steps, or evidence interpretation change.
