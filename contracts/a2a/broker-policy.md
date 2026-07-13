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
      "maxTasksPerDay": 20            // optional: tasks created per UTC day per class
    }
  ]
}
```

Matching is **first-match-wins on workerClass in document order** (a `*` rule
listed first shadows later class-specific rules — order rules deliberately).
Within the matched rule, checks run deny-first: `denyModes`, `allowIntents`,
`maxTasksPerDay`, then `requireApproval`. No matching rule falls through to
`defaultAction`.

## 2. Invariants

1. **Anonymous class axis only.** `workerClass` must come from the closed enum
   (`mobile | vps | source-only | unclassified`) or `*`. Any other value —
   in particular a concrete worker name — is rejected fail-closed, so the
   committed document can never leak fleet identity. The class derivation is
   shared with the `/stats/tasks` read path (single deriver), so budgets and
   stats always count the same classes.
2. **Fail-closed validation.** Unknown fields anywhere are an error — a typo
   like `denyIntents` must never silently no-op a safety rule. Rule ids are
   unique. A configured-but-invalid document **fails broker startup loudly**.
3. **Operator-committed only.** Policy changes land via operator commits to
   `docs/ops/broker-policy.json`; agents must not self-modify policy via PR.
4. **Missing document = legacy behavior.** No `A2A_BROKER_POLICY_FILE` means no
   policy evaluation at all — everything allowed, exactly as before G1.

## 3. Mode semantics (warn → enforce, the G1 pattern)

| Decision | `warn` | `enforce` |
|---|---|---|
| deny (create) | task proceeds; `task.policy_warned` audit with ruleId | create rejected `policy_denied` (HTTP 403); `task.policy_denied` audit |
| deny (claim) | claim proceeds; `task.policy_warned` audit | claim rejected `policy_denied`; `task.policy_denied` audit |
| requireApproval | task enters **blocked** (both modes) | same |
| allow | no effect | no effect |

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

- Runtime validator + engine: `packages/broker/src/core/broker-policy.ts`
  (`validateBrokerPolicyDocument`, `evaluateTaskPolicy`, `deriveTaskWorkerClass`).
- Broker wiring: create-time hook in `createTask` (post-readiness, pre-record),
  claim-time hook in `claimTask` (`packages/broker/src/core/broker.ts`).
- Config: `A2A_BROKER_POLICY_FILE` (or `brokerPolicyFile` option) pointing at a
  document; the document's own `mode` field decides warn vs enforce.
- Standalone CI/operator gate (no broker build needed):
  `scripts/check-broker-policy.mjs` — keep its rules in lockstep with the TS
  validator via this contract.
- Audit evidence: `task.policy_warned` / `task.policy_denied` events carry the
  ruleId and reason; a denied create still records evidence.

## 5. Rollout (G1-d)

v1 ships `mode: warn`, `defaultAction: allow`, `rules: []` — zero behavior
change until the operator commits rules. Promotion to `enforce` is a separate
operator decision after a warn-mode observation window with zero false
positives (per-rule `task.policy_warned` counts are the evidence).

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
ruleId                    taskDedupWarns  rawWarnEvents  intendedCanaryTasks  falsePositiveTasks
source-only-analyze-only  1               2              1                    0
```

The report must also name the broker population covered by the window. If one
broker has `A2A_BROKER_POLICY_FILE` wired and another does not, the packet must
say so; an `enforce` flip should not be treated as fleet-wide until every broker
that will enforce has loaded the same operator-committed policy document.

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
