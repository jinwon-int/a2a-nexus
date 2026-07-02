# Feature Spec: A2A Terminal Brief live-canary protocol

## Problem

The A2A Terminal Brief live-canary path was validated on broker-alpha fleet with a passing canary named `terminal-brief-live-fleet-broker-alpha-20260516T114832Z`. That canary exposed five hardening gaps in the live-canary/`operatorEvents` path that must be closed before the next real canary can run without depending on hand-written sequencing:

1. **Backlog false suppression** — canary scripts can accidentally start the poller after the task has completed, producing a false backlog suppression signal.
2. **Session key requirement** — `a2a.monitor.status` requires `sessionKey`; ad hoc scripts that omit it miss poller state entirely.
3. **Config shape flexibility** — Terminal Brief config shape can be object-backed (`{key: value}`) rather than array-backed (`[{key, value}]`); canary preflight must handle both.
4. **Cursor selection safety** — multiple cursor candidates can exist in the terminal outbox; selection must use the **latest** cursor safely without replaying stale entries.
5. **`operatorEvents` restore** — runtime windows that set `operatorEvents` must always restore `{"enabled": false}` on script completion *or* failure, not only on the success path.

## User / operator stories

- As an operator running a live canary, I want the canary poller to never report "backlog clear" when the task has already completed, so that a false-all-clear does not mask real poller issues.
- As an operator debugging a stalled canary, I want `a2a.monitor.status` to require an explicit `sessionKey` and never silently return an empty/null state, so that missing poller state is always visible.
- As an operator deploying the canary preflight, I want it to normalize both object-backed and array-backed config shapes, so that config schema drift does not silently bypass the canary.
- As an operator inspecting terminal outbox cursor state, I want cursor selection to always use the latest cursor, so replayed or stale outbox entries never advance cursor position.
- As an operator whose canary script fails or is interrupted, I want `operatorEvents` to be restored to `{"enabled": false}` regardless of exit path, so the Gateway does not remain in operator-event mode.

## Scope

### In scope

- Define the Terminal Brief live-canary lifecycle phases (preflight, poll, receipt, cleanup).
- Define acceptance criteria for each hardening gap.
- Define the acceptance contract with frozen assertions for the five hardening concerns.
- Define the fixture format and conformance test pattern.
- Containerize the acceptance contract so it can be validated in CI without a live canary.

### Out of scope

- Production deploy, restart, or canary execution unless explicitly approved.
- Plugin/implementation source code changes (covered by sibling lanes worker-beta, worker-alpha, worker-delta).
- Live provider/Telegram send.
- Terminal-outbox ACK mutation.
- Database mutation, prune, migration, or replay.
- Manual Terminal Brief ACK/replay.
- Secret movement, rotation, or disclosure.
- Repository visibility change or release publication.
- Gateway/broker/worker restart.

## Terminal Brief live-canary lifecycle

### Phase 1 — Preflight validation

Before the canary enters its poll loop, the preflight must pass these checks:

| Check | Acceptance rule | Hardening gap |
|-------|----------------|---------------|
| Task completion state | If the task is already in a terminal state (`done`, `cancelled`), canary must NOT start poller. A false backlog suppression signal is blocked. | #1 Backlog false suppression |
| Config shape normalization | Config may be object-backed `{key: value}` or array-backed `[{key, value}]`. Preflight normalizes to a canonical form. Must not assume a single shape. | #3 Config shape flexibility |
| `sessionKey` presence | Every `a2a.monitor.status` call must carry an explicit `sessionKey`. Missing `sessionKey` must cause a visible failure, not silent empty state. | #2 Session key requirement |
| `operatorEvents` baseline | Runtime must record the initial `operatorEvents` state before modifying it, so restore is possible on any exit path. | #5 `operatorEvents` restore |

### Phase 2 — Poll loop

The live-canary poll loop must respect these rules:

| Rule | Acceptance | Hardening gap |
|------|-----------|---------------|
| Cursor selection | Must compute the **latest** terminal outbox cursor before each poll cycle. Must reject stale cursors. | #4 Cursor selection safety |
| Poll state visibility | `a2a.monitor.status` output must include `pollerRunning`, `lastCursor`, `backlogCount`, and `sessionKey` fields. | #2 Session key requirement |
| Completion detection | If the task reaches a terminal state mid-poll, the poller must stop immediately. | #1 Backlog false suppression |

### Phase 3 — Receipt and evidence

After the poll loop completes (or the task terminates), the canary produces redacted evidence:

- The `terminal-brief` comment (Start/PR/Done/Block) as evidence ledger entry.
- The canary output artifact (redacted, no secrets, no session keys, no runtime paths).

### Phase 4 — Cleanup and restore

On any exit path (success, failure, interrupt):

| Rule | Acceptance | Hardening gap |
|------|-----------|---------------|
| `operatorEvents` restore | `operatorEvents` must be restored to `{"enabled": false}` regardless of how the script exits. | #5 `operatorEvents` restore |
| Resource cleanup | Poller timeout, cursor handles, and temp files must be cleaned up. | — |
| No double-post | If the canary is replayed, the evidence must not be duplicated. Dedupe key from manifest digest. | — |

## Hardening-gap acceptance criteria

### Gap 1 — Backlog false suppression

- [ ] Canary preflight must check task terminal state before starting poller.
- [ ] Must fail visibly (not silently skip) when task is already terminal.
- [ ] Must not produce a backlog-suppression signal for already-terminal tasks.
- [ ] If terminal state is reached mid-poll, poller must stop within one poll cycle.

### Gap 2 — Session key requirement

- [ ] Every `a2a.monitor.status` call must carry an explicit `sessionKey`.
- [ ] Missing `sessionKey` must cause a visible failure/error state, not silent empty/null state.
- [ ] `sessionKey` must be logged (redacted: show `sessionKey: <present>` not the raw value).
- [ ] Canary output must confirm `sessionKey` was provided in all poller state queries.

### Gap 3 — Config shape flexibility

- [ ] Canary preflight must accept both `object-backed` and `array-backed` config shapes.
- [ ] Normalization must produce a canonical internal form.
- [ ] Config shape metadata must be recorded in canary evidence (shape type, normalized fields).
- [ ] Shape assumption failure (e.g., assuming array when object is provided) must produce visible error.

### Gap 4 — Cursor selection safety

- [ ] Cursor selection must always select the latest terminal outbox cursor.
- [ ] Stale cursor must be rejected (cursor must advance monotonically).
- [ ] Replayed cursor must not trigger replay of already-evidenced terminal outbox entries.
- [ ] Cursor selection must be idempotent — identical inputs produce identical selection.
- [ ] Cursor selection failure must produce a visible error, not silent fallback to stale cursor.

### Gap 5 — `operatorEvents` restore

- [ ] `operatorEvents` baseline state must be captured before modification.
- [ ] Restore to `{"enabled": false}` must happen on normal exit.
- [ ] Restore to `{"enabled": false}` must happen on error/failure exit.
- [ ] Restore to `{"enabled": false}` must happen on interrupt/abort exit.
- [ ] If restore fails, the canary must produce a visible error (not silent skip).

## Success criteria

- [ ] Spec document defines the Terminal Brief live-canary protocol and five hardening gaps.
- [ ] Acceptance contract fixture exists at `fixtures/contract/terminal-brief-canary-acceptance.json` with frozen assertions for each gap.
- [ ] Conformance test exists at `test/conformance/check-terminal-brief-canary-acceptance.mjs` and validates all fixture scenarios pass.
- [ ] Test passes with no live canary, no provider send, no terminal-outbox ACK mutation.

## Evidence contract

Each worker/finalizer must produce the relevant evidence packet:

- Spec document URL.
- Fixture path and conformance test path.
- Conformance test exit code and output.
- Redacted evidence of each hardening gap's acceptance criteria.
- No secrets, host-specific paths, runtime/bootstrap files, or raw session dumps.
- Explicit confirmation that no live canary, provider send, terminal ACK, or deploy occurred.

## Safety and approval boundaries

### Secrets and private data

- No secrets, host paths, session keys (raw values), runtime/bootstrap context paths, or raw session dumps in spec, fixture, test, or evidence.
- `sessionKey` presence must be confirmed without revealing the key value.

### Human approval required for

- [ ] production deploy
- [ ] Gateway/broker/worker/service restart
- [ ] live canary/provider send
- [ ] DB mutation/prune/migration/replay
- [ ] manual Terminal Brief ACK/replay
- [ ] release/tag
- [ ] secret rotation/movement
- [ ] force push/history rewrite
- [x] none of the above

### Runtime/bootstrap and artifact hygiene gate

Before PR/Done/Block evidence publication, fail closed if any OpenClaw runtime/bootstrap context file would enter the branch diff or artifact evidence. Offending paths:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

### Broker foreground liveness

This spec, fixture, and conformance test are small, local-only operations. They do not overload a broker Telegram/DM foreground session. Testing runs independently of any broker foreground session.

## Rollback / failure handling

- **Failure mode:** conformance test exits non-zero, fixture assertion fails, or spec is incorrect.
- **Restore:** revert the spec/fixture/test files.
- **Safe cleanup:** none needed beyond git revert.
- **Requires approval:** none for spec/fixture/test changes.

## Reference map

| Artifact | Path | Purpose |
|----------|------|---------|
| Spec | `docs/specs/a2a-terminal-brief-canary/spec.md` | Canonical Terminal Brief canary protocol definition |
| Acceptance contract fixture | `fixtures/contract/terminal-brief-canary-acceptance.json` | Frozen assertions for the five hardening gaps |
| Conformance test | `test/conformance/check-terminal-brief-canary-acceptance.mjs` | Validates fixture against spec acceptance criteria |
| Parent issue | `a2a-plane#364` | A2A R27 Team1: Terminal Brief live-canary hardening |
| Current issue | `a2a-plane#365` | R27 Team1/worker-gamma: Terminal Brief canary spec and acceptance contract |
