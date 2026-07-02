# R26 Team1/workerGamma no-live Terminal Brief integration rehearsal

Parent: a2a-plane#360 (a2a-plane#360, internal tracker private)
Lane: a2a-plane#361 (a2a-plane#361, internal tracker private)
Run: `a2a-r26-team1-no-live-terminal-brief-integration-rehearsal-20260515T1832Z`
Broker of record: brokerAlpha
Worker: `workerGamma`
Team: Team1

This is the **no-live activation rehearsal packet** for receiving Team2/brokerBeta Terminal Brief output into brokerAlpha/workerGamma operations. It defines the concrete rehearsal steps, pass/fail criteria, rollback triggers, default-off verification, and operator approval blockers that will gate the final activation when Team2 implementation PRs arrive.

---

## R25 input references

This rehearsal builds on merged R25 artifacts:

| Artifact | Description |
|----------|-------------|
| a2a-plane#359 (a2a-plane PR #359, internal tracker private) | R25 Team1 ops-readiness gate framework (workerGamma lane) |
| a2a-plane#353 (a2a-plane#353, internal tracker private) / a2a-plane#351 (a2a-plane#351, internal tracker private) | R25 workerDelta validation matrix and parent |
| [a2a-docker-runner#275](https://github.com/jinwon-int/a2a-docker-runner/pull/275) | R25 docker-runner integration evidence |
| `team1-workerGamma-r25-ops-readiness-terminal-brief.md` | R25 ops-readiness gate definition (Domains G1&#8211;G5) |

The R25 gate framework defines **what** must be true. This rehearsal document defines **how to verify it in a no-live rehearsal**.

---

## Safety boundary (rehearsal restrictions)

This rehearsal is **no-live only**. All steps are read-only, config-only, or fixture-only.

- **No production deploy** — no broker image push, worker rollout, or container restart.
- **No Gateway/broker/worker restart or reload** — no process restart, health endpoint flip, or config reload.
- **No live provider/Telegram canary** — no provider send beyond A2A task completion comments.
- **No production DB mutation, prune, or migration** — no terminal-outbox write, ACK, cursor advance, or table alter.
- **No manual Terminal Brief ACK/replay** — no ACK endpoint call, no outbox replay, no cursor manipulation.
- **No historical outbox replay** — no rewind or re-dispatch of terminal-outbox events.
- **No secret movement, rotation, or value disclosure** — no key/credential change or plaintext exposure.
- **No release/tag publish, repo visibility change** — no npm publish, tag create, or public/private flip.
- **No public routing or worker retargeting** — no cross-broker route change, no worker broker reassignment.
- **Provider accepted/message-id evidence is send-acceptance only**, not read/visibility/Terminal ACK.

---

## Rehearsal domains

Each domain maps to the R25 gate framework and defines a **concrete no-live rehearsal step** with explicit pass/fail criteria.

### R1. Production safety gate compliance (maps to G1)

Verify that the R25 G1 preconditions are structurally satisfied for a no-live rehearsal context. This is a **document-review and config-inspection** gate.

| ID | Rehearsal step | How to pass | How it fails |
|----|---------------|------------|--------------|
| R1.1 | Review Team2 Terminal Brief contract &amp; fixture changes | `check-contract-fixtures.mjs` passes; no frozen contract modified without v0&#8594;v1 plan | Non-backward-compatible contract change without migration plan |
| R1.2 | Verify Terminal Brief routing guard does not accept live routes | `npm run check:terminal-brief-routing` passes | Routing guard allows `telegram_bot_api`, `telegram_curl`, or `direct_provider_send` |
| R1.3 | Verify ACK-boundary conformance | `check-terminal-evidence-ack-boundary.mjs` and `check-message-id-ack-boundary.mjs` pass | Provider `accepted`-send is promoted to terminal ACK |
| R1.4 | Verify no live-provider path in Terminal Brief code | PR diff scan: no `bot.sendMessage`, `provider.send`, `notifier.send` outside OpenClaw adapter | Live-provider path bypasses OpenClaw outbound adapter |
| R1.5 | Verify brokerAlpha broker image pinning plan | Pinned image tag recorded (even if dummy `r26-rehearsal`); `latest` is never the deploy target | No image tag recorded; `latest` is allowed |
| R1.6 | Verify Terminal Brief is default-off (see R3) | Config audit of broker/worker/plugin default-off surfaces | Any surface shows `terminalBriefEnabled: true` without explicit operator approval |

**Rehearsal command:**

```bash
node --test scripts/archive/check-team1-workerGamma-r26-no-live-terminal-brief-integration-rehearsal.test.mjs
node --test scripts/archive/check-team1-workerGamma-r25-ops-readiness-terminal-brief.test.mjs
npm run check:terminal-brief-routing
node test/conformance/check-contract-fixtures.mjs
node test/conformance/check-terminal-evidence-ack-boundary.mjs
npm run check:message-id-ack-boundary
```

**R1 pass condition:** All six R1.x steps pass and the above commands exit 0.

### R2. Rollback rehearsal (maps to G2)

Simulate the rollback procedure in a read-only context. No actual image revert or deploy is performed.

| ID | Rehearsal step | How to pass | How it fails |
|----|---------------|------------|--------------|
| R2.1 | Record pre-deploy broker image tag | Current `origin/main` broker tag and CI run URL are recorded in evidence | Tag not recorded |
| R2.2 | Record Terminal Brief-enabled image tag | Candidate tag (e.g., `r26-candidate`) recorded for rollback target reference | Candidate tag not documented |
| R2.3 | Define rollback trigger thresholds | Operator records: health fail threshold, outbox stall threshold, worker crash detection signal | Thresholds not documented |
| R2.4 | Rollback safety invariants check | Document that rollback does not ACK outbox, mutate DB, rotate secrets, edit Gateway config, or rewrite history | Any invariant violated in written plan |
| R2.5 | Post-rollback verification plan | Document health-check, default-off flag, and no-live state verification steps | Post-rollback verification not defined |

**Rehearsal pass condition:** All R2.x steps produce documented evidence. No actual image revert, deploy, or restart is performed or authorized.

### R3. Default-off verification (maps to G3)

Verify the default-off posture across all config surfaces. This is a **config audit**, not a live deploy.

| ID | Rehearsal step | How to pass | How it fails |
|----|---------------|------------|--------------|
| R3.1 | Broker config check | `terminalBriefEnabled: false` (or equivalent) confirmed in broker runtime config or documented default | Flag is absent or defaults to `true` |
| R3.2 | Worker notification adapter check | No live target, route, or provider configured; `liveProviderSend: false` | Live send path is default-allowed |
| R3.3 | Plugin notification bridge check | Gateway notification config is empty or `notificationDisabled: true` | Notification bridge has default-active targets |
| R3.4 | Receipt/ACK path check | ACK mutation commands fail in dry-run; `productionAckAttempted: false` | ACK path is default-allowed |
| R3.5 | Cross-broker relay check | Relay config is absent or `relayEnabled: false` | Relay is default-enabled |
| R3.6 | Config diff review | Diff between pre-deploy and current config contains no accidental enablement of Terminal Brief | Diff shows Terminal Brief flag set to `true` without approval |

**Rehearsal pass condition:** All R3.x steps confirm default-off posture. Any failure is a Block for this rehearsal and for future activation.

### R4. Operator approval boundary definition (maps to G4)

Define the exact approval boundaries that will apply when Team2 implementation PRs are ready. This is a **documentation rehearsal** — no actual approval is granted.

| ID | Rehearsal step | How to pass | How it fails |
|----|---------------|------------|--------------|
| R4.1 | List all actions requiring approval | Merge Team2 PR, deploy broker, deploy worker, set `terminalBriefEnabled: true`, send live canary, ACK outbox, run rollback | Any action missing from approval list |
| R4.2 | Define approval format | Each approval must be separate comment, name exact action, reference evidence, be bounded, be explicit | Approval format allows bundled or unbounded approval |
| R4.3 | Document no-approval zone | CI/conformance/evidence posting/docs/issue mgmt are explicitly listed as not requiring approval | No-approval zone is not documented |
| R4.4 | Define approval revocation process | If an operator revokes approval, in-progress action must stop and rollback | No revocation process exists |

**Rehearsal pass condition:** All R4.x steps are documented. No approval is granted or implied by this rehearsal.

### R5. Runtime/bootstrap hygiene (maps to G5)

| ID | Rehearsal step | How to pass | How it fails |
|----|---------------|------------|--------------|
| R5.1 | Guard paths in branch diff | `git diff --name-only -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw` returns empty | Any guard path is present in diff |
| R5.2 | Guard paths in checked-out repo | No guard-path file exists in the repo checkout | File found (exact path reported) |
| R5.3 | Secret-shaped content scan | Scan for GitHub PAT tokens, authorization bearer headers, cache boundary markers, session identifiers, and local root path patterns across docs/validation and scripts/ | Token-shaped content detected in evidence files |

**Rehearsal pass condition:** All R5.x checks pass.

---

## Rehearsal verification commands

Run from the repository root after a clean checkout:

```bash
# Core rehearsal test suite
node --test scripts/archive/check-team1-workerGamma-r26-no-live-terminal-brief-integration-rehearsal.test.mjs

# R25 gate framework conformance (prerequisite pass)
node --test scripts/archive/check-team1-workerGamma-r25-ops-readiness-terminal-brief.test.mjs

# Terminal Brief routing guard
npm run check:terminal-brief-routing

# Contract fixture conformance
node test/conformance/check-contract-fixtures.mjs

# ACK boundary
node test/conformance/check-terminal-evidence-ack-boundary.mjs
npm run check:message-id-ack-boundary

# Bootstrap hygiene guard
git diff --name-only -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw

# Secret-shaped content scan (defined in guard list — actual patterns are never written literally)
# The scan covers GitHub tokens, auth bearer headers, cache boundary markers, session keys, and local path patterns.
```

---

## Rehearsal evidence packet

After completing all rehearsal steps, capture the evidence in a structured output:

```json
{
  "rehearsalRun": "a2a-r26-team1-no-live-terminal-brief-integration-rehearsal-20260515T1832Z",
  "lane": "team1-workerGamma",
  "round": "R26",
  "state": "NO-LIVE_REHEARSAL",
  "domains": {
    "R1": { "status": "pass|fail", "failures": [] },
    "R2": { "status": "pass|fail", "failures": [] },
    "R3": { "status": "pass|fail", "failures": [] },
    "R4": { "status": "pass|fail", "failures": [] },
    "R5": { "status": "pass|fail", "failures": [] }
  },
  "overall": "REHEARSAL_PASS|REHEARSAL_FAIL",
  "activationGate": "NO-GO / Waiting on Team2 implementation PRs",
  "safety": {
    "productionDeploy": false,
    "gatewayRestart": false,
    "liveTelegramSend": false,
    "dbMutation": false,
    "terminalAck": false,
    "outboxReplay": false,
    "secretChange": false,
    "repoVisibilityChange": false
  }
}
```

---

## Activation gate advancement

When Team2 implementation PRs arrive, this rehearsal packet becomes the **base activation GO/NO-GO packet**. The operator:

1. Re-runs the rehearsal commands against the new PR branch.
2. Confirms all R1&#8211;R5 domains still pass.
3. If Team2 changes are no-diff (docs-only/docs-adjacent only) with no new live paths, proceeds to conditional GO.
4. If Team2 changes introduce new code paths, extends the rehearsal with domain-specific checks.
5. Posts the GO/NO-GO decision referencing this rehearsal packet.
6. Operator approval is still required before any live activation (R4 boundaries apply).

### GO condition

- All R1&#8211;R5 rehearsal domains pass with current evidence.
- Team2 implementation PR is merged and its CI passes.
- No live path was introduced without OpenClaw outbound adapter.
- Operator approval comment exists for the merge.

### NO-GO conditions (any one is sufficient)

- Any R1&#8211;R5 domain fails.
- Team2 implementation PR is open/unmerged and this rehearsal run predates it.
- Team2 PR introduces live-provider paths that bypass the OpenClaw outbound adapter.
- Hygiene scan (R5) fails.
- Operator approval not yet granted.

### BLOCK conditions

- Team2 implementation ACK-promotes provider accepted-send to terminal ACK.
- Frozen contracts are modified without v0&#8594;v1 plan.
- Bootstrap/runtime context files appear in the branch or evidence.
- Secret-shaped content detected in evidence files.
- Default-off flag is confirmed `true` in production config without approval.

---

## Residual risks

| Risk | Mitigation | Status in this rehearsal |
|------|-----------|-------------------------|
| Team2 PR may change scope after this rehearsal | Rehearsal must be re-run against actual PR before activation GO | Documented re-run requirement |
| Rehearsal does not test live Gateway notification bridge | Rehearsal is no-live by design; bridge testing is a separate pre-activation step | Explicit blocker on live activation |
| Config drift between rehearsal and activation time | Rehearsal records snapshot timestamps; config diff re-checked at activation | Documented re-check requirement |
| Operator approval may be bundled or missing | R4 documents exact approval format and boundaries | Documented approval requirement |
| Rehearsal commands may not exist in the PR branch | Rehearsal files must be present in the PR target (main) before activation | Rehearsal files are added in this round |

---

## Safety confirmation

This rehearsal:

- Did not deploy or restart any Gateway, broker, or worker service.
- Did not mutate production databases or terminal-outbox ACK rows.
- Did not send any live provider or Telegram message.
- Did not perform Terminal Brief ACK/replay or historical outbox replay.
- Did not open a broad cross-broker relay window.
- Did not change secrets, repository visibility, or release state.
- Did not rewrite history or force-push.
- Did not grant or imply operator approval.
- Provider accepted/message-id evidence is provider-accepted evidence only, never read/visibility/terminal ACK.
- Used redacted repository evidence only.

---

## Closeout boundary

This lane produces the R26 no-live integration rehearsal packet. The packet itself does not activate Terminal Brief, accept Team2 code into brokerAlpha production, grant operator approval, replace the R25 gate framework, or unblock live activation without a separate operator approval round.
