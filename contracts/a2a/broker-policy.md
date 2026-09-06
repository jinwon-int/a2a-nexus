# Contract: Broker Policy Document v1

Status: v1, warn-first rollout. Umbrella: referee track #1354, issue #1355 (G1).
Composes the finalizer verdict (#1383) and result provenance (#1380) as the
policy leg of the referee track: **agent capabilities are determined by the
broker, not agent goodwill.**

A **broker policy document** is a single operator-committed JSON document that
declares what anonymous worker CLASSES may do. The broker evaluates it at task
**create-time** and **claim-time**. It consolidates what previously lived only
in docs/skill discipline (unenforced) and scattered per-gate modules.

## 1. Document shape (`a2a.broker.policy.v1`)

```jsonc
{
  "schemaVersion": "a2a.broker.policy.v1",
  "mode": "warn",                    // warn | enforce
  "defaultAction": "allow",          // applied when no rule matches; v1 ships allow
  "rules": [
    {
      "id": "mobile-analyze-only",   // unique, lower-kebab; surfaced in audits/denials
      "workerClass": "mobile",       // mobile | vps | source-only | unclassified | *
      "allowIntents": ["analyze"],   // optional: intent NOT in list -> deny
      "denyModes": ["apply"],        // optional: payload.mode in list -> deny
      "requireApproval": true,        // optional: route to blocked -> operator approve
      "maxTasksPerDay": 20,           // optional: tasks created per UTC day per class
      "requireImplementationCapability": true // optional: implementation lane needs a verified profile
    }
  ]
}
```

Matching is **first-match-wins on workerClass in document order** (a `*` rule
listed first shadows later class-specific rules — order rules deliberately).
Within the matched rule, checks run deny-first: `denyModes` (fail-closed on an
undetermined mode — see invariant 2), `allowIntents`,
`requireImplementationCapability`, `maxTasksPerDay`, then `requireApproval`. No
matching rule falls through to `defaultAction`.

## 2. Invariants

1. **Anonymous class axis only.** `workerClass` must come from the closed enum
   (`mobile | vps | source-only | unclassified`) or `*`. Any other value —
   in particular a concrete worker name — is rejected fail-closed, so the
   committed document can never leak fleet identity. The class derivation is
   shared with the `/stats/tasks` read path (single deriver), so budgets and
   stats always count the same classes. `source-only` is the task-derived safety
   class selected by `payload.sourceOnly=true` or `payload.mode="source-only"`;
   it is not a named worker identity. The operator rule therefore permits
   read-only verification and local no-GitHub-write proposals, while
   `github-propose-patch` remains incompatible with the class.
2. **Fail-closed mode resolution (BUG-B4).** `denyModes` is evaluated
   fail-closed: when the matched rule declares `denyModes` and the evaluator was
   not given a non-empty `mode` string, the task is **denied**
   (`mode could not be determined …`, CLI reason code `mode_undetermined`).
   Previously an absent `mode` skipped the whole `denyModes` branch, so a
   payload whose `mode` was present but not a string — which the broker
   normalizes to `undefined` — bypassed the rule and fell through to `allow`.
   A caller that positively established the task declares no mode at all opts
   out with `modeResolution: "absent"`; omitting the field means
   "undetermined" and denies, so dropping the plumbing fails closed like the
   `requireImplementationCapability` and `maxTasksPerDay` gates.
3. **Fail-closed validation.** Unknown fields anywhere are an error — a typo
   like `denyIntents` must never silently no-op a safety rule. Rule ids are
   unique. A configured-but-invalid document **fails broker startup loudly**.
4. **Operator-committed only.** Policy changes land via operator commits to
   `docs/ops/broker-policy.json`; agents must not self-modify policy via PR.
   The prohibition is on an agent *deciding* a policy change — loosening its own
   constraints — not on transcription. An agent MAY open a policy PR when the
   operator has directed the specific change, provided the PR states the
   directive, changes nothing beyond it, and is approved and merged by the
   operator. Absent an explicit operator directive, an agent proposing a policy
   edit is exactly what this rule forbids.
5. **Missing document = legacy behavior.** No `A2A_BROKER_POLICY_FILE` means no
   policy evaluation at all — everything allowed, exactly as before G1.

## 3. Mode semantics (warn → enforce, the G1 pattern)

| Decision | `warn` | `enforce` |
|---|---|---|
| deny (create) | task proceeds; `task.policy_warned` audit with ruleId | create rejected `policy_denied` (HTTP 403); `task.policy_denied` audit |
| deny (claim) | claim proceeds; `task.policy_warned` audit | claim rejected `policy_denied`; `task.policy_denied` audit |
| requireApproval | task enters **blocked** (both modes) | same |
| allow | no effect | no effect |

`requireImplementationCapability` (#1597) is evaluated **at claim-time only**,
and only for the implementation-lane intents `propose_patch`, `propose_params`
and `apply_local_change`. When set, the claiming worker must publish a verified
`implementationCapability` profile — see
[implementation-lane readiness](../../docs/implementation-lane-readiness.md).
Claim-time enforcement covers clauses 1 to 3 of that rule (`capable`, recorded
runtime/provider/model tier, `canary_passed`); pins and heartbeat recency are
scheduler concerns and are documented there. `canPatchWorkspace` alone is
deliberately not sufficient: it says the worker may edit a workspace, not that
it has a usable runtime, provider route, model tier and current canary.

The rule fails closed. A worker that never declared a profile is denied, and so
is a claim where the readiness input is missing entirely — only an explicit
create-time evaluation opts out, so dropping the plumbing denies rather than
silently disabling the gate. (A worker unknown to the broker never reaches this
rule; `claimTask` rejects it earlier with `not_found`.)

The referee package never receives a worker identity — the broker computes
readiness and passes only a boolean plus a secret-safe reason string, so the
deny reason carries normalized capability ids and never a worker name, hostname
or credential material. Rules that omit the field are unaffected, so the gate is
opt-in per committed policy document.

Claim-time policy audits are de-duplicated per `(task, rule, action)`: a denied
claim returns HTTP 403, which the worker treats as skip-and-retry, so an
un-deduplicated event would be written on every poll.

`requireApproval` routes to the existing blocked → operator-approve → queued
flow **in both modes** deliberately: blocking is recoverable (one operator
action un-blocks), unlike a deny, so it does not wait for enforce promotion.
This matches the #1355 acceptance canary.

Claim-time re-evaluation exists because the claiming worker's class can differ
from the create-time target's (e.g. the worker re-registered under a different
mode). Budgets (`maxTasksPerDay`) are counted at create-time only, per UTC day,
over the broker's live task table. An operator approval already on the task
satisfies a `requireApproval` rule at claim.

## 4. Enforcement points and evidence

- Runtime validator + engine: `packages/policy-referee/src/broker-policy.ts` (broker consumes via `@openclaw/a2a-policy-referee`)
  (`validateBrokerPolicyDocument`, `evaluateTaskPolicy`, `deriveTaskWorkerClass`).
- Broker wiring: create-time hook in `createTask` (post-readiness, pre-record),
  claim-time hook in `claimTask` (`packages/broker/src/core/broker.ts`).
- Config: `A2A_BROKER_POLICY_FILE` (or `brokerPolicyFile` option) pointing at a
  document; the document's own `mode` field decides warn vs enforce.
- Standalone CI/operator gate (no broker build needed):
  `scripts/check-broker-policy.mjs` — keep its rules in lockstep with the TS
  validator via this contract. Both sets are fail-closed on unknown fields, so a
  field added to only one of them makes the other reject every document that
  uses it. `scripts/check-broker-policy.test.mjs` asserts the two `RULE_FIELDS`
  sets are equal; add a field to both in the same commit.
- **Rollout ordering for a new rule field.** Because validation is fail-closed
  and a configured-but-invalid document fails broker startup loudly, deploy
  brokers that understand the field *before* committing a document that uses it,
  and remove the field from the document *before* rolling brokers back. The
  reverse order prevents affected brokers from starting.
- Audit evidence: `task.policy_warned` / `task.policy_denied` events carry the
  ruleId and reason; a denied create still records evidence.

### 4.1 Deployment path: how the committed document reaches a broker (#2064)

Invariant 4 says policy changes land via operator commits to
`docs/ops/broker-policy.json`. Until #2064 this contract said nothing about how
that committed document reaches the file a broker actually loads, and there was
no automation for it — deployment was a human copying a file onto a host. The
two therefore diverged silently for two months: the committed document said
`mode: "warn"` while one live broker had been running `mode: "enforce"` since
2026-07-22, with byte-identical rules. Every repo-side check stayed green, and
reviews repeatedly concluded "the document is `warn`, so there is no live
behaviour change" — which was false for that broker.

**The committed document is canonical. The live file is a deployed copy of it,
and drift between them is a defect, not a configuration option.**

Both directions are subcommands of the same CLI, so validation and deployment
cannot drift apart:

```bash
# detect (read-only, never repairs)
node scripts/check-broker-policy.mjs drift [--live PATH] [--canonical PATH]

# deploy (dry-run by default; --apply is the only writing path)
node scripts/check-broker-policy.mjs sync  [--live PATH] [--apply]
```

`--live` defaults to `/var/lib/a2a-broker/broker-policy.json`, the conventional
`A2A_BROKER_POLICY_FILE` target.

- **Comparison is normalized, not byte-for-byte.** Both documents are parsed and
  deep-compared with object keys sorted; rule *array order* is significant
  because §1 matching is first-match-wins. A byte-only difference (indent,
  trailing newline, key order) passes with a printed note rather than failing —
  a checker that fails on cosmetics trains operators to ignore it, which is the
  failure mode that let the real `mode` drift hide. Exit codes: `0` match,
  `1` policy drift, `2` either document missing/unparseable or the canonical
  document invalid (fail-closed; an unreadable side is never assumed equal).
- **`drift` never picks a winner.** It prints the differing field paths and
  fails. Deciding whether the repo is stale or the host drifted is an operator
  decision under invariant 4; a checker that auto-corrected would be an agent
  self-modifying policy.
- **`sync` is dry-run unless `--apply`.** With `--apply` it backs the existing
  live document up to `<live>.bak-<UTC timestamp>` before writing, then re-reads
  from disk and re-compares to verify the write landed. It refuses to deploy a
  canonical document that does not validate: invariant 3 makes a
  configured-but-invalid document fail broker startup loudly, so pushing one
  would take the broker down at its next restart.
- **A file swap alone changes nothing — a restart is required.** The broker
  reads the document exactly once, at `createServer`
  (`packages/broker/src/server.ts:412-413`), and passes the parsed snapshot to
  `createBroker`; there is no watcher and no reload route. `sync` therefore
  prints the restart instruction and does **not** restart anything — a broker
  restart is a fresh-approval operator action.
- **Post-restart verification.** A configured-but-invalid or unreadable document
  fails startup loudly, so a broker that comes up healthy with
  `A2A_BROKER_POLICY_FILE` set is the evidence that it loaded the document.
  Confirm with `check-broker-policy.mjs drift` afterwards.

**Where each check runs.** The schema gate (`check-broker-policy.mjs` with no
subcommand) is the CI/release-gate leg and stays there. `drift` is deliberately
**not** a CI gate: CI runners have no route to a broker host and no fleet
credentials, and granting them standing ssh access to read one file would be a
larger permanent risk than the drift it detects. `drift` runs on each broker
node, where the live file is — as a post-deploy step and on a schedule. After
any commit that changes `docs/ops/broker-policy.json`, run `sync` (dry-run,
then `--apply` under approval) and `drift` on **every** broker in the population
named by the §5.1 promotion packet; a policy commit is not deployed until every
one of them reports a match.

## 5. Rollout (G1-d)

v1 ships `mode: warn`, `defaultAction: allow`, `rules: []` — zero behavior
change until the operator commits rules. Promotion to `enforce` is a separate
operator decision after a warn-mode observation window with zero false
positives (per-rule `task.policy_warned` counts are the evidence).

**Current state (2026-09-06): promoted to `enforce`, fleet-wide.** The T1 broker
had been running `enforce` since 2026-07-22 while this repo's committed
document still said `warn`; the two were never linked by any tooling, so the
divergence went unnoticed for two months and caused a live broker's posture to
be misread from the repo (a2a-nexus#2064). The operator's ruling is that the
enforcing state is correct and the committed document was the stale side, so
the document now says `enforce` and both brokers run it.

Two things follow, and they are the point of this paragraph:

- The observation-window requirement above is **satisfied by the operating
  record, not by a fresh window**: T1 enforced for over two months with no
  `task.policy_denied` events. A new warn window would add nothing.
- **Never infer a broker's posture from this repo alone.** The committed
  document is canonical for what the posture *should* be; what a broker is
  actually running is the file at `A2A_BROKER_POLICY_FILE`. Check it directly:

  ```bash
  docker inspect <broker-container> \
    --format '{{range .Config.Env}}{{println .}}{{end}}' | grep POLICY
  python3 -c "import json;d=json.load(open('/var/lib/a2a-broker/broker-policy.json'));\
    print(d['mode'], [r['id'] for r in d['rules']])"
  ```

  Closing that gap with tooling — a sync path plus a drift check, so this can
  never diverge silently again — is tracked in a2a-nexus#2064.

### 5.1 Observation report shape

The warn-mode observation report MUST distinguish two counts:

1. **Task-deduplicated policy hits** — one hit per `(taskId, ruleId)` pair. This
   is the false-positive denominator: if create-time and claim-time both warn
   for the same intended canary task, that is still one policy judgment surface.
2. **Raw enforcement-point hits** — one hit per audit event. This forecasts the
   exact create-time and claim-time surfaces that would turn into `policy_denied`
   under `enforce`.

A valid G1-d promotion packet SHOULD include both tables, for example:

```text
ruleId                   taskDedupWarns  rawWarnEvents  intendedCanaryTasks  falsePositiveTasks
source-only-safe-intents 1               2              1                    0
```

The report must also name the broker population covered by the window. If one
broker has `A2A_BROKER_POLICY_FILE` wired and another does not, the packet must
say so; an `enforce` flip should not be treated as fleet-wide until every broker
that will enforce has loaded the same operator-committed policy document.

### 5.2 Observation-driven source-only correction

The first warn window produced 30 raw warnings across 15 task-deduplicated hits:
one intentional canary and 14 non-canary tasks. Six local no-GitHub-write
`propose_patch` tasks succeeded, while two read-only verification tasks also hit
the analyze-only rule. Those eight tasks demonstrated that
`source-only-analyze-only` would block legitimate workflows under `enforce`.

The operator policy therefore uses `source-only-safe-intents`: `analyze`,
`verify`, and local `propose_patch` are allowed; write-capable
`github-propose-patch` and generic `patch` modes remain denied. The dispatcher
also rejects `sourceOnly=true` with `github-propose-patch` before `POST /tasks`,
even when explicit write flags are present.

This correction does **not** promote the policy. The document remains in
`warn`, and promotion requires a fresh observation window and a replacement
canary after the corrected policy is deliberately rolled out. The old canary's
`intent=analyze` plus `mode=propose-patch` is now an allowed case and must not be
reused as proof that the corrected deny path fires.

## 6. Boundaries / non-goals (v1)

- Budgets are create-time counters over the current UTC day, derived on demand;
  no persistent rolling counters. A **source-only** sub-agent token counter source
  now exists (`a2a-broker.worker-subagent-budget-counter.packet`,
  `packages/broker/src/core/worker-subagent-budget-counter.ts`): it derives a
  shrink-only spawn ceiling from supplied normalized token usage but does **not**
  enforce at runtime. `maxSubagentBudget` runtime enforcement stays deferred until
  a runtime spawn gate consumes this counter.
- No per-worker (named) rules, ever — the class axis is the contract.
- The policy engine gates task lifecycle only; it does not re-run judgments or
  replace the finalizer verdict / approval systems it routes into.
