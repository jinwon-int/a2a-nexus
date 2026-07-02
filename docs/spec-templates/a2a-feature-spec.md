# Feature Spec: <name>

## Problem

What operational, developer, broker, worker, or operator problem are we solving?

## User / operator stories

- As an operator, ...
- As a broker/finalizer, ...
- As a worker, ...
- As a maintainer, ...

## Scope

### In scope

- ...

### Out of scope

- Production deploy/restart/canary unless explicitly approved.
- DB mutation/prune/migration/replay unless explicitly approved.
- Manual Terminal Brief ACK/replay unless explicitly approved.
- Secret movement/output unless explicitly approved.
- ...

## Success criteria

- [ ] ...
- [ ] ...

## Safety and approval boundaries

### Secrets and private data

- What credential/private-data classes could be nearby?
- How will the change avoid logging, committing, or publishing them?

### Human approval required for

- [ ] production deploy
- [ ] Gateway/broker/worker/service restart
- [ ] live canary/provider send
- [ ] DB mutation/prune/migration/replay
- [ ] manual Terminal Brief ACK/replay
- [ ] release/tag
- [ ] secret rotation/movement
- [ ] force push/history rewrite
- [ ] none of the above

### Broker foreground liveness

- Could this overload a broker Telegram/DM foreground session?
- What work will be detached into subagents, TaskFlow, scripts, or evidence workers?

## Verification design

- What oracle/check proves the change?
- Is the oracle independent from the implementation lane? If not, what finalizer coverage review breaks the loop?
- For new gates/scanners/CI wiring, what red-to-green evidence will be captured?
- For removal/cleanup tasks, where is the discovery inventory recorded before edits begin?
- For multi-stage work, which follow-up issues/tasks materialize later stages before closeout?

## Evidence contract

Each worker/finalizer must produce the relevant evidence packet:

- affected repos/files;
- PR/issue links;
- tests/build/lint/checks run;
- CI status and mergeability when relevant;
- risk notes;
- rollback/failure notes;
- final recommendation or blocker.

## Rollback / failure handling

- What indicates failure?
- What state must be restored?
- What cleanup is safe without additional approval?
- What cleanup requires fresh approval?

## Wiki/runbook follow-up

- Does this create reusable operating knowledge?
- If yes, where should it be recorded?
