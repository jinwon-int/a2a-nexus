# R25 Team1 bangtong operations-readiness gate for Team2 Terminal Brief → Seoseo production

Parent: a2a-plane#351 (a2a-plane#351, internal tracker private)
Lane: a2a-plane#352 (a2a-plane#352, internal tracker private)
Run: `a2a-r25-team1-ops-readiness-terminal-brief-20260515T1656Z`
Broker of record: Seoseo
Worker: `bangtong`
Team: Team1
Order: 1/1 (single-child lane)

This is the Team1/bangtong operations-readiness gate for accepting Team2/Gwakga Terminal Brief changes into Seoseo production. It defines the production safety gate, rollback criteria, default-off checks, and operator approval boundaries that Team1/Seoseo must verify before Team2 Terminal Brief feature code is activated in the Seoseo production broker and worker fleet.

This document is a **validation evidence packet only**. It does not deploy, restart, or mutate any production service. It does not activate Terminal Brief, send a live provider canary, ACK terminal-outbox rows, change secrets, change repository visibility, publish a release, rewrite history, or force-push.

---

## Safety boundary

This lane:

- Does not deploy or restart any Gateway, broker, or worker service.
- Does not mutate production databases or terminal-outbox ACK rows.
- Does not send any live provider or Telegram message.
- Does not perform Terminal Brief ACK/replay or historical outbox replay.
- Does not open a broad cross-broker relay window.
- Does not change secrets, repository visibility, or release state.
- Does not rewrite history or force-push.
- Does not execute operator approval — it defines the boundaries within which approval is required.
- Provider accepted/message-id evidence is provider-accepted evidence only, never read/visibility/terminal ACK.
- Uses redacted repository evidence only.

---

## Domain 1: Production safety gate (G1)

The production safety gate defines the conditions under which Team2 Terminal Brief changes may be accepted into Seoseo production. It is a **Team1-operators-review** gate, not an automated gate — an operator must review the evidence and affirm the decision.

### G1.1 Preconditions for acceptance

| Condition | Verification evidence | Fail-closed condition |
|-----------|---------------------|-----------------------|
| Team2 Terminal Brief PR has passed its own review, CI, and conformance tests in the Gwakga broker repo | PR link, CI run link, conformance test output (redacted) | PR is open, CI is red, or conformance fails |
| Team2 Terminal Brief code does not change the four-level receipt hierarchy or promote provider accepted-send to terminal ACK | `check-terminal-brief-routing.mjs` pass; `check-message-id-ack-boundary.mjs` pass | Routing or ACK-boundary check fails |
| Team2 Terminal Brief code does not introduce new terminal states or modify the frozen v0 state machine | `check-contract-fixtures.mjs` pass | Contract fixture conformance fails |
| Team2 Terminal Brief code does not require a live provider send, DB mutation, or terminal-outbox ACK mutation at merge time | PR diff shows no live-provider paths, no DB mutation, no ACK mutation | PR contains live-send, DB-mutation, or ACK-mutation code paths |
| The Seoseo broker image/tag planned for deploy is pinned (not `latest`) and has a verifiable CI pass | Image tag and CI run URL | Image is unpinned or CI is untrusted |
| The Seoseo worker fleet (`bangtong`, `dungae`, `sogyo`) is patched to the commit that includes the Terminal Brief changes | Worker commit SHAs recorded and verified | Worker fleet version is not confirmed |
| Terminal Brief feature is **default-off** in both broker config and worker runtime (see Domain 3) | Config diff shows `terminalBriefEnabled: false` (or equivalent) | Default is on, or no default-off mechanism exists |

### G1.2 Acceptance gate check

```
Decision required: GO or NO-GO before any live activation.

GO conditions (all must be met):
  - All G1.1 preconditions pass with linked evidence.
  - Operator has reviewed the precondition evidence and explicitly posts a GO decision
    (a separate comment, not inferred from CI passes or Start markers).
  - The default-off flag (see Domain 3) is confirmed set to `false` in production config.

NO-GO conditions (any one is sufficient):
  - Any G1.1 precondition is not met.
  - Operator review identifies unresolved risk.
  - Default-off flag is not set or not verifiable.

BLOCK conditions:
  - Team2 Terminal Brief code promotes provider accepted-send to terminal ACK.
  - Team2 Terminal Brief code modifies frozen contract fixtures without v0→v1 plan.
  - Team2 Terminal Brief code introduces live-provider-send paths that bypass the
    OpenClaw outbound adapter.
  - Runtime/bootstrap context files or secrets enter the branch diff or evidence.
```

---

## Domain 2: Rollback criteria (G2)

Rollback is the process of reverting the Seoseo production state to a pre-Terminal-Brief baseline. Rollback must be rehearsable and evidence-producing before live activation.

### G2.1 Rollback triggers

| Trigger | Detection | Rollback action | Evidence required after rollback |
|---------|-----------|-----------------|----------------------------------|
| Broker health check fails after Terminal Brief deploy | `/health` returns `ok: false`, hot-table coverage drops, or mirror mismatches | Revert broker image to prior pinned tag; restart broker | Broker `/health` returning `ok: true` with pre-deploy coverage |
| Terminal outbox rows stuck in `unacknowledged` for >5 minutes after expected ACK cycle | Outbox diagnostic shows stuck rows; no progress after one reaper interval | Revert broker image; do NOT manually ACK stuck rows | Outbox diagnostic showing no rows lost or incorrectly acked |
| Worker handler crashes or returns structured errors on Terminal Brief tasks | Worker logs show `docker_runner_*` errors or unhandled exceptions on Terminal Brief fields | Revert worker commit; redeploy worker from prior frozen commit | Worker health check; terminal route handler test passes |
| Default-off flag is discovered to be `true` in production (Terminal Brief accidentally live) | Config audit or incident report | Set `terminalBriefEnabled: false` and verify; do NOT ack any sent notifications | Config audit shows `terminalBriefEnabled: false`; no notifications were sent |
| Operator-initiated rollback | Operator explicitly posts rollback command | Full revert of broker image and worker commit | Operator confirms rollback complete; no-live state verified |

### G2.2 Rollback rehearsal requirements

Before Terminal Brief can be activated in Seoseo production, an operator must successfully rehearse the rollback procedure in a non-production environment and post redacted evidence.

| Rehearsal step | Pass condition | Fail-closed condition |
|---------------|----------------|-----------------------|
| Pin pre-deploy broker image tag | Operator records the pre-deploy image tag and CI run | Image tag is not recorded before deploy |
| Deploy Terminal Brief broker image | Operator records the deploy command, output, and health probe | Deploy command not recorded or health probe fails |
| Detect rollback trigger | Operator demonstrates the monitoring signal that would trigger rollback | Monitoring signal is not defined or not testable |
| Revert broker to pre-deploy image | Operator records the revert command and verify it succeeds | Revert command is not rehearsed or fails |
| Revert worker to pre-deploy commit | Operator records the worker revert command and verify | Worker revert is not rehearsed or fails |
| Verify no-live state after rollback | Operator records health check and confirms Terminal Brief is default-off | Post-rollback state is not verified |

### G2.3 Rollback safety invariants

- **No terminal-outbox ACK mutation during rollback.** Rollback must not ACK, advance, or prune terminal-outbox rows. Unacked rows remain replayable for reconciliation.
- **No production DB mutation during rollback.** Rollback is image/commit revert only.
- **No secret rotation during rollback.** Rollback does not change secrets, API keys, or provider targets.
- **No Gateway config mutation during rollback.** Broker and worker config revert through image/commit rollback, not through live Gateway config edits.
- **No force-push or history rewrite during rollback.** Evidence is posted as issue comments, not branch rewrites.

---

## Domain 3: Default-off checks (G3)

Terminal Brief must be **default-off** in Seoseo production. Activation requires explicit operator approval for a bounded window. These checks verify the default-off posture.

### G3.1 Default-off configuration surfaces

| Surface | Default-off mechanism | Verification check |
|---------|---------------------|-------------------|
| Broker Terminal Brief config | Feature flag `terminalBriefEnabled: false` (or equivalent) in broker runtime config | Config audit shows flag is false; no deploy path that sets it true without approval |
| Worker Terminal Brief notification path | Notification adapter permits no-live mode by default; no target, route, or provider is configured | `liveProviderSend: false` in worker evidence; notification adapter requires explicit allowlist for live send |
| Plugin-level Gateway notification bridge | OpenClaw plugin config for operator events is empty or has `notificationDisabled: true` | Plugin config audit; `--no-live` preflight check on notification path |
| Receipt/ACK path | No ACK mutation path is enabled by default; ACK requires explicit operator approval | Terminal-outbox preflight shows `productionAckAttempted: false` in dry-run mode |
| Cross-broker Terminal Brief relay | Seoseo does not relay Terminal Brief to downstream brokers unless explicitly enabled | Relay config is absent or has `relayEnabled: false` |

### G3.2 Default-off verification checklist

Before accepting Team2 Terminal Brief changes into Seoseo production, verify every item:

- [ ] **Broker config:** `terminalBriefEnabled` (or equivalent) is `false` in the production config file.
- [ ] **Worker notification adapter:** no live target, route, or provider is configured; `--no-live` preflight passes.
- [ ] **Plugin notification bridge:** operator events config is empty or `notificationDisabled: true`.
- [ ] **Terminal-outbox ACK guard:** ACK mutation commands fail in dry-run mode unless approval is present.
- [ ] **Cross-broker relay:** relay is disabled; no Terminal Brief payload is forwarded to downstream brokers.
- [ ] **Provider send guard:** live provider send is blocked by default; no default allowlist exists.
- [ ] **Config diff review:** the diff between pre-deploy and current config contains no accidental enablement of Terminal Brief.
- [ ] **Operator verification:** an operator has reviewed the config diff and posted a verification comment (separate from Start marker).

### G3.3 Accidental enablement protection

If a default-off check fails (any flag is `true` when it should be `false`):

1. **Stop.** Do not proceed with any deploy, restart, or Terminal Brief activation.
2. **Set to false.** Set the flag to `false` and verify.
3. **Post Block evidence.** Record the accidental-enablement finding, what was changed, and what was verified post-fix.
4. **Do not ACK.** If the accidental enablement caused a provider send, do not ACK the terminal-outbox rows. Record provider accepted-send evidence as non-ACK only.

---

## Domain 4: Operator approval boundaries (G4)

Operator approval is the mechanism that gates live production actions. These rules define what requires approval, what the approval must contain, and how it must be recorded.

### G4.1 Actions requiring explicit operator approval

| Action | Approval required? | Approval format |
|--------|-------------------|-----------------|
| Accept Team2 Terminal Brief PR into Seoseo production (merge decision) | ✅ Required | Operator comment on the lane issue or parent issue confirming precondition evidence is reviewed |
| Deploy Terminal Brief-enabled broker image to production | ✅ Required | Separate approval (not bundled with merge approval); must name exact image tag and deploy window |
| Deploy Terminal Brief-enabled worker commit to production fleet | ✅ Required | Separate approval; must name exact worker commit and rollout scope |
| Set `terminalBriefEnabled: true` in production (live activation) | ✅ Required | Separate approval; must name exact activation window, scope, and rollback plan |
| Send a live provider/Telegram canary notification | ✅ Required | Separate approval; must name the exact one-shot task ID and canary scope |
| ACK terminal-outbox rows | ✅ Required | Separate approval; must name exact receipt-bound evidence and row range |
| Run rollback procedure | ✅ Required | Operator-initiated rollback — the same operator who approved activation may initiate; must post rollback decision comment |
| Run release gate, conformance tests, or no-live checks | ❌ Not required | Automated; no approval needed for no-live CI or local validation |
| Post Start, PR, Done, or Block evidence | ❌ Not required | Evidence posting is standard lane output |
| Record operator decisions or evidence | ❌ Not required | Documentation does not require approval |

### G4.2 Approval format

Each operator approval comment must:

1. **Be a separate GitHub issue comment** — not bundled with CI output, test results, or terminal evidence.
2. **Name the exact action being approved** — e.g., "I approve deploying broker image v1.2.3-terminal-brief-rc1 to the Seoseo production environment for a bounded 2-hour observation window starting at 2026-05-16T00:00Z."
3. **Reference linked evidence** — e.g., "Preconditions verified at #352#issuecomment-xxxx."
4. **State rollback authority** — e.g., "I retain the authority to initiate rollback at any time."
5. **Be timestamped** — GitHub comment timestamps are sufficient.
6. **Be explicit** — phrases like "looks good" or "approved" without scope are insufficient. The comment must state what is approved.

### G4.3 Approval boundaries

- Approval is **not delegation**. The operator approving an action is responsible for its outcome.
- Approval does **not extend** to other actions. Approving merge does not approve deploy; approving deploy does not approve activation; approving activation does not approve ACK.
- Approval can be **revoked**. If an operator revokes approval, any in-progress action must stop and rollback.
- Approval must be **bounded** (time-limited or task-scoped). Open-ended approval is not valid.
- Automated approval (from tests, CI, or GitHub workflow) is **not** operator approval. Only a human operator comment counts.
- Provider accepted-send evidence is **not** operator approval.

### G4.4 No-approval zone

These actions never require operator approval and must not be described as requiring it:

- Running CI, conformance tests, release gate, or no-live validation.
- Posting evidence (Start, PR, Done, Block).
- Updating docs, runbooks, contracts, or fixtures.
- Opening or closing issues.
- Recording operator decisions that have already been made.

---

## Domain 5: Runtime/bootstrap and artifact hygiene (G5)

Before PR/Done/Block evidence publication, fail closed if any OpenClaw runtime/bootstrap context file would enter the branch diff. Offending paths:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

### Hygiene scan result (this run)

```
Guard paths in repo checkout: absent — all clean.
```

Evidence must also avoid: secrets, tokens, host-private paths, raw session dumps, provider targets, chat IDs, private source snippets, and unredacted logs.

---

## GO/NO-GO decision matrix

| Aggregate state | Required gates | Allowed closeout |
|----------------|---------------|------------------|
| `GO` | G1 (production safety gate) precondition checklist passed and operator-reviewed; G2 (rollback criteria) rehearsed; G3 (default-off checks) all pass; G4 (operator approval) boundaries documented and respected; G5 (hygiene) clean | Done/PR evidence may say the ops-readiness gate for accepting Team2 Terminal Brief changes into Seoseo production is defined, verified, and operator-review-complete. |
| `GO_CANDIDATE / Needs operator review` | G1 preconditions have evidence but operator review is pending; G2 rehearsed; G3 verified; G4 boundaries documented; G5 clean | Done/PR evidence may request operator review. Must not claim acceptance approval. |
| `NO-GO / Waiting` | Any gate has Start-only or missing evidence; G3 default-off check fails; G2 rehearsal incomplete; G5 hygiene scan fails | Block or Done evidence documenting the specific gate and what resolution is needed. |
| `BLOCK` | Safety violation: bootstrap files in branch, secret leak, unapproved live action, Terminal Brief config accidentally enabled, or Team2 code that promotes accepted-send to ACK | Stop and report exact violation, file path, and rejection rationale. |

### Current aggregate decision

**Decision: `GO_CANDIDATE / Needs operator review`.** The ops-readiness gate is defined for all five domains. Each gate has documented pass/fail conditions, verification evidence requirements, and fail-closed conditions. The definitions and checks have been validated through local no-live checks. However, no live production activation has occurred, and the operator review step in Domain 1 remains pending by design — this document only defines the gate framework, not the acceptance outcome.

---

## Residual risk matrix

| Risk area | Mitigation | Current posture | Fail-closed condition |
|-----------|-----------|-----------------|-----------------------|
| Team2 Terminal Brief code drifts from acceptance contract | G1 preconditions require conformance test pass before acceptance | Defined but not yet executed against a specific Team2 PR | Terminal Brief PR merged without conformance verification |
| Default-off flag is accidentally enabled in production | G3 defines verification checklist and accidental-enablement protection | Checklist is documented; actual config audit is an operator task | Default-off not verified before deploy |
| Rollback procedure not rehearsed before live activation | G2 defines rehearsal requirements | Procedure is documented; rehearsal is an operator task | Activation attempted without rehearsed rollback |
| Operator approval scope creep | G4 defines approval boundaries (merge ≠ deploy ≠ activate ≠ ACK) | Boundaries are documented and gated | Operator uses one approval for multiple actions |
| Hygiene failure in posted evidence | G5 scan required before evidence publication | This document passes scan | Bootstrap file or secret enters evidence |
| Team2 code changes only validated in Gwakga, not in Seoseo | G1 requires Seoseo-specific CI and conformance pass | Not yet executed — Team2 PR is not yet available for this round | Terminal Brief accepted without Seoseo-side validation |

---

## Safety confirmation

This lane:

- Did not deploy or restart any Gateway, broker, or worker service.
- Did not mutate production databases or terminal-outbox ACK rows.
- Did not send any live provider or Telegram message beyond normal A2A task completion notifications.
- Did not perform Terminal Brief ACK/replay or historical outbox replay.
- Did not open a broad cross-broker relay window.
- Did not change secrets, repository visibility, or release state.
- Did not rewrite history or force-push.
- Did not execute approval without fresh explicit operator approval.
- Provider accepted/message-id evidence is provider-accepted evidence only, never read/visibility/terminal ACK.
- Used redacted repository evidence only (validation document, local no-live checks).
- Confirmed runtime/bootstrap hygiene before evidence publication (guard paths absent).

---

## Validation commands

```bash
# Contract fixture conformance
node test/conformance/check-contract-fixtures.mjs

# Terminal Brief routing guard
npm run check:terminal-brief-routing

# ACK boundary conformance
node test/conformance/check-terminal-evidence-ack-boundary.mjs

# Message ID ACK boundary
npm run check:message-id-ack-boundary

# Ops-readiness gate test
node --test scripts/archive/check-team1-bangtong-r25-ops-readiness-terminal-brief.test.mjs

# Release gate (full)
npm run release-gate
```

## Reference map

| Domain | Source contracts | Related validation docs |
|--------|-----------------|------------------------|
| G1: Production safety gate | `contracts/a2a/terminal-semantics.md`, `contracts/a2a/task-lifecycle.md`, `contracts/a2a/r20-stability-gate.md` | `docs/release-gate.md`, `docs/validation/team1-bangtong-r23-spec-first-acceptance-contract.md` |
| G2: Rollback criteria | `packages/broker/docs/production-stabilization-20260429.md`, `packages/broker/docs/terminal-brief-live-readiness-go-no-go-matrix.md` | `docs/validation/team1-yukson-terminal-brief-activation-libero.md` |
| G3: Default-off checks | `packages/broker/docs/receipt-gate-canary-matrix.md`, `packages/openclaw-plugin-a2a/docs/canary-receipt-gated-runtime-preflight.md` | `docs/validation/team2-terminal-brief-activation-libero.md` |
| G4: Operator approval boundaries | `contracts/a2a/terminal-semantics.md` (Safety gates) | `docs/readiness/fail-closed-scanner-readiness.md` |
| G5: Hygiene | `docs/release-checklist.md`, `docs/readiness/fail-closed-gates.json` | `docs/security/r4-external-scan-and-freeze.md` |

---

## Closeout boundary

This lane publishes the ops-readiness gate definition and a `GO_CANDIDATE` decision. It defines what Team1/Seoseo must verify before accepting Team2 Terminal Brief changes into Seoseo production. It does not claim that Team2 code has been accepted, that production activation is GO, or that operator approval has been obtained. Production acceptance remains a later Team1 operator decision that references this gate definition.
