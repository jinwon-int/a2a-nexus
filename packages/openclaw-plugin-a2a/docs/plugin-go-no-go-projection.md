# Plugin Final Go/No-Go Status Projection

Issue: [jinwon-int/plugin-a2a#265](https://github.com/jinwon-int/plugin-a2a/issues/265)
Parent: [jinwon-int/plugin-a2a#263](https://github.com/jinwon-int/plugin-a2a/issues/263)
Run: `a2a-plugin-final-go-no-go-projection-20260511T053000Z`

## Purpose

The plugin go/no-go projection module (`src/plugin-go-no-go-projection.ts`) produces a
**definitive, operator-facing GO/NO_GO answer** for the source-public execution lifecycle.

It answers the question: "Can the operator safely proceed with source-public execution?"

The projection synthesises:

1. **Plugin health** — is the plugin enabled, activated, and configured?
2. **Execution plan status** — from the source-public execution orchestrator (#263/#264)
3. **Safety invariants** — are all safety gates confirmed?
4. **Preflight results** — did all required checks pass?

## Go/No-Go Decisions

| Decision | Meaning |
|----------|---------|
| `GO` | All gates passed. Execution is ready pending operator acknowledgment. |
| `NO_GO` | Hard blockers prevent execution. Remediation is required. |
| `CONDITIONAL_GO` | Execution is possible but operator action items remain outstanding. |

## Decision Pipeline

```
Plugin Health Check
  ├─ Disabled?          → NO_GO (plugin_disabled)
  ├─ Not activated?     → NO_GO (plugin_not_activated)
  └─ Active ────────────→ Execution Plan Evaluation
                            ├─ No plan?          → CONDITIONAL_GO
                            ├─ Safety violation? → NO_GO
                            ├─ NO_GO plan?       → NO_GO
                            ├─ Preflight fail?   → NO_GO
                            ├─ Needs approval?   → CONDITIONAL_GO
                            └─ GO_CANDIDATE?     → GO
```

## API

### `projectPluginGoNoGo(input, config, options?)`

```ts
import { projectPluginGoNoGo } from "./plugin-go-no-go-projection.js";

const result = projectPluginGoNoGo(
  {
    executionPlan,   // optional SourcePublicExecutionPlan
    executionStatus, // optional ExecutionStatusProjection
    metadata,        // optional operator context
  },
  pluginRuntimeConfig,
  { runId: "my-check" },
);

// result.goNoGo       → "GO" | "NO_GO" | "CONDITIONAL_GO"
// result.title        → operator-facing title
// result.summary      → one-line operator summary
// result.rationale    → why this decision was reached
// result.pluginHealth → health summary for the operator
// result.requiredActions → operator must complete these
// result.warnings     → cautionary notes for the operator
```

## Projection Schema

```ts
interface PluginGoNoGoProjection {
  schema: "a2a.plugin.go-no-go.projection.v1";
  runId: string;
  producedAt: number;           // epoch ms
  goNoGo: "GO" | "NO_GO" | "CONDITIONAL_GO";
  title: string;
  summary: string;
  rationale: string;
  reasonCategory: PluginGoNoGoReasonCategory;
  pluginHealth: PluginHealthSummary;
  executionStatus?: ExecutionStatusProjection;
  safetyConfirmation: SafetyConfirmation;
  requiredActions: RequiredOperatorAction[];
  warnings: string[];
  metadata: Record<string, unknown>;
}
```

## Plugin Health Summary

| Field | Meaning |
|-------|---------|
| `enabled` | Plugin is enabled (not denied) |
| `explicitlyActivated` | Plugin is allowlisted and explicitly enabled |
| `operatorEventsEnabled` | Operator event bridge is active |
| `brokerConfigured` | A `baseUrl` is configured |
| `summary` | Human-readable health description |

## Requester-Visible vs Operator-Only Diagnostics

| Diagnostic surface | Operator-visible | Requester-visible | Example |
|--------------------|-----------------|-------------------|---------|
| Plugin health (`enabled`, `explicitlyActivated`) | ✅ Full detail | ✅ Full detail | `plugin not activated` |
| Browser base URL presence | ✅ Full detail | ✅ Full detail | `broker.example.test` (never raw secrets) |
| Safety invariant pass/fail | ✅ Per-invariant detail | ✅ Compact summary | `❌ No terminal ACK` vs `safety: 1 invariant violated` |
| Required action checklist | ✅ Full list, blocking vs advisory | ✅ Blocking-actions-only | `Enable the plugin in config (blocking)` |
| Warnings list | ✅ Full list | ✅ Full list (redacted) | `Operator events are disabled` |
| Provider send evidence | ✅ Redacted ID + explicit non-ACK label | ✅ Redacted ID + explicit non-ACK label | `provider_accepted (non-ACK)` |
| Terminal ACK eligibility | ✅ Full status + receipt mode | ✅ Blocking gated | `terminal ack blocked: no receipt` |
| Runtime logs / stack traces | ✅ Internal details | ❌ **Not visible** | — |
| Raw config secrets | ✅ Never in output | ❌ **Never in output** | — |

**Key separation:** Requester-visible diagnostics never expose raw secrets,
internal stack traces, or provider-message-id values without redaction. The
`safeSessionKeyLabel()` helper in `plugin-errors.ts` replaces raw session keys
with `<missing>`, `<empty>`, or `<present>` labels for all public surfaces.

## Diagnostic Message Inventory

The following table catalogues every diagnostic message produced by the
GO/NO-GO projection module, its audience, and its safety posture.

### Summary messages (projection.title + projection.summary)

| Condition | Title | Summary | Audience | Safety |
|-----------|-------|---------|----------|--------|
| Plugin disabled | `⛔ NO_GO — Source-Public Execution Blocked` | `Plugin is disabled...` | Both | ✅ No ACK, no live |
| Plugin not activated | `⛔ NO_GO — Source-Public Execution Blocked` | `Plugin is not explicitly activated...` | Both | ✅ No ACK, no live |
| Preflight failed | `⛔ NO_GO — Source-Public Execution Blocked` | `Preflight checks failed...` | Both | ✅ No ACK, no live |
| Hard blocker | `⛔ NO_GO — Source-Public Execution Blocked` | `Hard blockers prevent execution...` | Both | ✅ No ACK, no live |
| Safety violated | `⛔ NO_GO — Source-Public Execution Blocked` | `...safety invariants are violated...` | Both | ✅ No ACK, no live |
| Operator gates pending | `⚠️ CONDITIONAL GO — Operator Action Required` | `Operator approval required...` | Both | ✅ No ACK, no live |
| GO ready | `✅ GO — Source-Public Execution Ready` | `All gates passed...` | Both | ✅ No ACK, no live |

### Warnings (projection.warnings[])

| Condition | Wording | Audience |
|-----------|---------|----------|
| No broker baseUrl | `No broker baseUrl configured — broker operations will fail until configured` | Both |
| Operator events off | `Operator events are disabled — terminal receipt monitoring is unavailable` | Both |
| Simulated-only steps | `N step(s) are simulated-only and never executed in this round` | Both |

### Required actions (projection.requiredActions[])

| Condition | Action | Blocking? |
|-----------|--------|-----------|
| Plugin disabled | `Enable the A2A Broker Adapter plugin in config` | ✅ |
| Not activated | `Explicitly activate the plugin (plugins.allow or enabled:true)` | ✅ |
| Safety violated | `Verify and restore all safety invariants` | ✅ |
| Hard blocker | `Resolve hard-blocker gate failures and re-run rehearsal` | ✅ |
| Operator gate (approval) | `Review and approve N operator-gated step(s)` | ✅ |
| Operator gate (pending) | `Resolve or waive pending gates: <list>` | ✅ |
| Operator gate (acknowledgment) | `Acknowledge N operator-gated step(s)` | ✅ |

### Operator-facing failure messages (projection.rationale)

| Condition | Rationale example | Non-ACK evidence? |
|-----------|-------------------|-------------------|
| Plugin disabled | `Plugin is disabled. Enable the plugin...` | ✅ Yes, `projectionIsSafe: true` |
| Plugin not activated | `Plugin is not explicitly activated. Set enabled:true...` | ✅ Yes, `projectionIsSafe: true` |
| No broker baseUrl | `No broker baseUrl configured — broker operations will fail until configured` | ✅ Yes, non-ACK projection |
| No execution plan | `No execution plan provided. Run the source-public execution orchestrator first...` | ✅ Yes, non-ACK projection |
| Safety violation | `One or more safety invariants are violated. Execution is blocked...` | ✅ Yes, non-ACK projection |
| Plan NO_GO | `Execution plan is NO_GO. <rationale> Preflight failures: <list>` | ✅ Yes, non-ACK projection |
| Preflight failed | `Preflight checks failed: <list>. Remediation required before execution.` | ✅ Yes, non-ACK projection |
| Needs approval | `Execution plan is NEEDS_OPERATOR_APPROVAL. <rationale>` | ✅ Yes, non-ACK projection |
| GO candidate | `GO: all required gates passed. N operator-gated step(s) and M simulated-only step(s)...` | ✅ Yes, non-ACK projection |

## Evidence Semantics: Provider-Accepted vs Terminal ACK

The GO/NO-GO projection **never treats provider-accepted evidence as terminal
ACK evidence**. This is a permanent fail-closed policy, not an alpha limitation.

### What the projection guarantees

| Evidence kind | Is GO evidence? | Is terminal ACK? | Rationale |
|--------------|-----------------|------------------|-----------|
| Projection produced (this module) | ✅ Conditional | ❌ Never | A projection is evidence of evaluation, not operator receipt |
| Preflight checks passed | ✅ Yes | ❌ Never | Preflight confirms readiness, not terminal completion |
| Safety invariants confirmed | ✅ Yes | ❌ Never | Safety invariants are projection constraints, not delivery receipts |
| Operator actions listed | ✅ Yes | ❌ Never | Required actions are advisory, not terminal ACK |
| Warnings present | ✅ Yes | ❌ Never | Warnings are informational, not terminal ACK |
| Provider accepted a send (elsewhere) | ❌ Not in this module | ❌ Never | Provider send acceptance is handled by the notification adapter, never by go/no-go |

### What the projection explicitly excludes

- **No provider send status**: The projection module has no provider send
  interface. All provider-related evidence is handled by the notification
  adapter and receipt contract, never by the go/no-go projection.
- **No terminal outbox ACK**: The projection module never calls broker
  terminal-outbox ACK endpoints. It produces projection artifacts only.
- **No live execution**: The projection module never executes provider sends,
  deploys, restarts, or production DB mutations.

### Message wording: "terminal ack blocked" vs "provider_sent"

When an operator-facing message uses "terminal ack blocked":

```
"receipt timed out — must refresh before ack"
```

This is a **projection-only status label** — it does not mean an ACK was
attempted and failed. It means the receipt evidence does not qualify for ACK
eligibility. The module responsible for actually performing a terminal-outbox
ACK (`operator-notification-adapter.ts`) is a separate code path.

## Redacted No-Live Examples

All examples in this document use placeholder URLs and IDs. Never paste
production broker URLs, edge secrets, Telegram targets, or raw runtime dumps
into evidence documentation.

### Redacted projection example (safe for shared evidence)

```ts
const result = projectPluginGoNoGo(
  {
    executionPlan: sampleExecutionPlan,
    metadata: { runId: "evidence-demo" },
  },
  configActive(),  // uses "https://broker.example.test"
);

// result.runId        → "plugin-go-nogo-<timestamp>"  (never contains real task IDs)
// result.goNoGo       → "GO" or "NO_GO" or "CONDITIONAL_GO"
// result.pluginHealth → { enabled: true, explicitlyActivated: true, brokerConfigured: true, ... }
// result.safetyConfirmation.projectionIsSafe → true  (always)
// result.requiredActions → [] (non-blocking advisory when fully configured)
```

### Redacted projection failure message (operator-facing)

```
⛔ NO_GO — Source-Public Execution Blocked

Summary: Plugin is not explicitly activated.
Set enabled:true and add to plugins.allow.

Rationale: Plugin is not explicitly activated.
Set enabled:true and add to plugins.allow.

Required actions:
  [BLOCKING] Explicitly activate the plugin
    (plugins.allow or enabled:true)
    Reason: Plugin must be allowlisted and enabled for execution

Safety confirmation:
  ✅ No live execution (invariant held)
  ✅ No provider send (invariant held)
  ✅ No terminal ACK (invariant held)
  ✅ No deploy (invariant held)
  ✅ No DB mutation (invariant held)
```

### Redacted preflight scan evidence (CI-safe)

```bash
$ npm run scan:public-readiness
=== plugin-a2a public-readiness scan ===
[1/6] raw API-key / token patterns …
  → 0 potential token/API-key findings
[2/6] non-example / private broker URLs …
  → 0 potential non-example URL findings
[3/6] numeric Telegram chat IDs …
  → 0 potential numeric Telegram chat ID findings
[4/6] raw edgeSecret / literal secret values …
  → 0 potential raw edgeSecret findings
[5/6] live notification target configs …
  → 0 potential live notification target findings
[6/6] runtime/bootstrap context file leakage …
  → 0 context-file leakage findings

=== SCAN PASSED: no public-readiness/secret findings ===
```

These examples use placeholder values (`broker.example.test`,
`telegram:<operator-chat-id>`, `${A2A_EDGE_SECRET}`) suitable for public shared
evidence. Never substitute production values.

## Safety Confirmation Statement

Every projection carries `safetyConfirmation.projectionIsSafe: true`. The module:

- **Never** performs approval, release, or visibility changes
- **Never** executes live provider sends, deploys, restarts, or terminal ACK
- **Never** mutates production DB
- **All outputs are projection artifacts** — no real side effects
- **Provider-accepted evidence is not terminal ACK** — the module explicitly
  separates provider acceptance from operator receipt semantics

## Running Tests

```bash
npm ci
npm run build
npm test                                  # Full test suite
node --test tests/plugin-go-no-go-projection.test.ts   # This module only
node --test tests/status-card-wording.test.ts          # Provider-ACK wording tests
```

## Integration

This module is the **final status projection** in the source-public execution lifecycle:

1. **Approval rehearsal** (dry-run): projects approval packets without broker contact
2. **Execution orchestrator** (#263/#264): converts approved packets into deterministic plans
3. **Plugin go/no-go projection** (this module): synthesises everything into an operator-facing GO/NO_GO

Use this module when the operator needs a definitive answer:

1. **Pre-execution check:** Run the projection to confirm GO status before proceeding
2. **Operator dashboard:** Display the projected status card showing health, warnings, and required actions
3. **Audit trail:** Save the projection as evidence of the go/no-go evaluation

## Related

- [Source-Public Execution Orchestrator](./source-public-execution-orchestrator.md) — execution plan production
- [Dry-Run Approval Projection](./dry-run-approval-projection.md) — approval packet projection
- [Approval Rehearsal](./approval-rehearsal.md) — source-public approval rehearsal
- [Operator Install Checklist](./operator-install-checklist.md) — full operator diagnostics and runbook
