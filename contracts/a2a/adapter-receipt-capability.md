# Adapter Receipt Capability Contract (v0)

> **v0 (2026-05-22):** The receipt capability contract for non-OpenClaw/Hermes/spool Terminal Brief
> adapters is defined. Adapter states (`produced`, `spooled`, `provider_only`) are explicitly mapped
> to the four receipt levels and must never be mistaken for operator-visible ACK. This contract is a
> companion to [Terminal Result Semantics](./terminal-semantics.md) and
> [Terminal Evidence ACK Boundary](../compatibility/terminal-evidence-ack-boundary.md).

## 1. Scope

### 1.1 What this contract covers

This contract defines the receipt capability model for **non-OpenClaw/Hermes/spool Terminal Brief
adapters** — adapter implementations that produce or deliver Terminal Brief notifications without
using the OpenClaw Gateway's outbound lifecycle (`openclaw_outbound_lifecycle`), the Hermes
reference worker's spool (`spool_message`, `spool_batch`), or the OpenClaw terminal outbox replay
(`terminal_outbox_replay`) path.

Examples of in-scope adapters:

- Standalone A2A broker adapter written in Python, Go, or Rust targeting Telegram Bot API directly.
- CLI-based adapter that writes Terminal Brief evidence to a file or pipe for operator processing.
- External notification service adapter that receives A2A task-event webhooks and dispatches
  via its own provider integration.
- Custom bridge adapter connecting an A2A broker to a non-OpenClaw notification channel.

### 1.2 What this contract does NOT cover

| Excluded path | Reason | Fallback contract |
| --- | --- | --- |
| OpenClaw `openclaw_outbound_lifecycle` | Already defined in routing contract | `terminal-brief-routing-contract.ts`, `terminal-brief-core-contract.md` |
| OpenClaw `openclaw_gateway_notifier` | Already defined in routing contract | `terminal-brief-routing-contract.ts` |
| OpenClaw Hermes `spool_message` / `spool_batch` | Hermes-owned path | `hermes-worker-integration` spec, `contracts/a2a/worker-capability-profile.md` |
| OpenClaw `terminal_outbox_replay` | Spool-based replay path | `terminal-brief-routing-contract.ts` |
| GitHub comment evidence projection | Separate projection mechanism | `contracts/a2a/github-evidence-projection.md` |

### 1.3 Relationship to existing contracts

This contract **extends** the four receipt levels defined in
[Terminal Result Semantics](./terminal-semantics.md) by adding adapter-specific capability levels.
It does **not** add new receipt levels (which would require a v0→v1 plan per the v0 freeze). It
only maps adapter-observable states to the existing four-level model.

All existing non-ACK invariants from
[Terminal Evidence ACK Boundary](../compatibility/terminal-evidence-ack-boundary.md) apply:
`providerAccepted`, `providerMessageId`, `sendStatus: accepted`, and `sendStatus: sent` are
always level 1 (accepted-send only), regardless of adapter implementation.

---

## 2. Adapter receipt capability levels

A non-OpenClaw/Hermes/spool adapter may produce evidence at one of six capability levels.
These are adapter-local states that map to one of the four frozen receipt levels.

### 2.1 Capability level definitions

| Capability level | Adapter state | Description | Receipt level mapping | ACK-safe? |
| --- | --- | --- | --- | --- |
| **C1** | `produced` | The adapter serialized the Terminal Brief payload and wrote it to its local buffer, file, or stdout. No send attempt has been made. The payload exists in adapter-local memory or ephemeral storage only. | Level 0 (no receipt evidence) | No |
| **C2** | `spooled` | The adapter queued the Terminal Brief payload to an external spool or outbox (e.g., local SQLite queue, AWS SQS, Redis list, file-based spool directory). The payload is durable beyond adapter process lifetime but has not been delivered to any provider. | Level 0 (no receipt evidence) | No |
| **C3** | `provider_only` | The adapter dispatched the payload to a provider (Telegram Bot API, Slack webhook, email SMTP, etc.) and received an HTTP 2xx or equivalent provider-side acceptance. `providerMessageId` may be available if the provider returned one. | Level 1 (accepted-send) | No |
| **C4** | `requester_visible` | The adapter has evidence that the payload appeared in a channel observable by the requesting system (e.g., a GitHub issue/PR comment was created or updated by a bot user). | Level 2 (requester-visible receipt) | No |
| **C5** | `operator_visible` | A human operator explicitly confirmed seeing the Terminal Brief (e.g., via Telegram delivery confirmation, manual acknowledgment, or current-session-visible proof). | Level 3 (operator-visible receipt) | No (evidence) |
| **C6** | `operator_confirmed` | The operator has provided an explicit ACK-safe receipt proof (`manual_operator_receipt` or `current_session_visible` with a `receiptProofId` that the adapter can reference). | Level 4 (terminal ACK) | Yes |

### 2.2 Invariants

1. **Monotonicity**: An adapter's receipt capability is monotonic in capability level index (C1 < C2 < C3 < C4 < C5 < C6). Evidence at a higher level subsumes all lower levels. An adapter must not report C4+ without having passed through C3 (provider send).
2. **No skip-to-ACK**: An adapter must never claim C6 (terminal ACK) without first reaching C5 (operator-visible receipt) with explicit receipt evidence. An adapter that directly jumps from C3 to C6 is in violation.
3. **No-ACK from C1/C2**: `produced` (C1) and `spooled` (C2) represent zero delivery evidence. They must never be promoted to any receipt level above level 0, and must never be cited as proof of delivery, operator visibility, or terminal ACK.
4. **Provider acceptance is always level 1**: Even when an adapter reaches C6, the original `providerAccepted`, `providerMessageId`, and `sendStatus` values remain level 1 (accepted-send only). They are never ACK evidence themselves.

### 2.3 State machine

```
                  ┌──────────┐
                  │ C1: produced │
                  └─────┬────┘
                        │ serialize & persist
                        v
                  ┌──────────┐
                  │ C2: spooled │
                  └─────┬────┘
                        │ provider dispatch
                        v
                  ┌──────────┐
                  │ C3: provider_only │
                  └─────┬────┘
                        │ requester visibility detected
                        v
                  ┌──────────┐
                  │ C4: requester_visible │
                  └─────┬────┘
                        │ operator confirms receipt
                        v
                  ┌──────────┐
                  │ C5: operator_visible │
                  └─────┬────┘
                        │ ACK-safe receipt proof recorded
                        v
                  ┌──────────┐
                  │ C6: operator_confirmed │
                  └──────────┘
```

---

## 3. Adapter evidence shape

### 3.1 Required fields

A non-OpenClaw/Hermes/spool adapter that reports receipt capability evidence must include:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `adapterType` | `string` | yes | Adapter implementation identifier (e.g., `python-telegram-bot`, `go-webhook-bridge`, `cli-file-outbox`). |
| `adapterReceiptLevel` | `string` | yes | One of: `produced`, `spooled`, `provider_only`, `requester_visible`, `operator_visible`, `operator_confirmed`. Corresponds to capability level C1–C6. |
| `receiptLevel` | `number` | yes | The frozen receipt level this maps to: `0`, `1`, `2`, `3`, or `4`. |
| `providerMessageId` | `string` | no | Provider-assigned message id if available. Must be labeled as accepted-send evidence, never ACK. |
| `providerAccepted` | `boolean` | no | Whether the provider accepted the send. Must default to `false` when C1 or C2. |
| `ackSafeReceiptProof` | `object` | no | Present only when `adapterReceiptLevel` is `operator_confirmed` (C6). Must include `receiptType` (`manual_operator_receipt` or `current_session_visible`), `receiptProofId`, and `provenance`. |
| `terminalOutboxAckMutated` | `boolean` | yes | Must always be `false` for non-OpenClaw/Hermes/spool adapters (they cannot write to the terminal outbox). |
| `adapterDurableEvidence` | `string` | no | URL or file path referencing durable evidence of the adapter state (e.g., log file, spool directory entry, webhook response). Must be redacted and public-safe. |

### 3.2 Forbidden adapter claims

| Claim | Reason |
| --- | --- |
| `"terminalOutboxAckMutated": true` | Non-OpenClaw adapters must not claim terminal outbox ACK mutation. |
| `"adapterReceiptLevel": "operator_confirmed"` without `ackSafeReceiptProof` | C6 requires explicit receipt proof. |
| `"adapterReceiptLevel": "provider_only"` or higher without any provider interaction | Provider evidence must be grounded in actual provider interaction. |
| `"receiptLevel": 4` when `adapterReceiptLevel` is `produced`, `spooled`, or `provider_only` | Receipt level 4 requires operator visible receipt (C5) or confirmed (C6). |

---

## 4. ACK eligibility for non-OpenClaw/Hermes/spool adapters

### 4.1 General rule

A non-OpenClaw/Hermes/spool adapter **cannot independently perform terminal-outbox ACK mutation**.
Only the OpenClaw terminal-outbox replay path (`terminal_outbox_replay`) and the explicit
operator-approval-gated ACK mutations may set `terminalOutboxAckMutated: true`.

Adapter evidence at C6 (`operator_confirmed`) may be **used as input** to a terminal-outbox ACK
decision by the parent broker or an operator, but the adapter itself must always report
`terminalOutboxAckMutated: false`.

### 4.2 ACK-input evidence chain

For a parent broker to consider ACK based on adapter evidence:

```
Adapter C6 evidence (operator_confirmed)
  → referencedReceiptProof: { receiptType, receiptProofId }
  → parent broker verifies the receipt proof independently
  → parent broker performs the ACK mutation (terminal-outbox replay)
  → adapter terminalOutboxAckMutated remains false
```

The adapter never mutates the ACK column itself. The ACK mutation is always an operator or
parent-broker action using the adapter's evidence as one input.

### 4.3 No-ACK from adapter send success alone

Even if the adapter produces C3 (`provider_only`) with a valid `providerMessageId`, that is
**never** terminal ACK evidence. The four non-ACK signals from the ACK boundary contract apply
regardless of adapter implementation:

- `providerMessageId` — non-ACK
- `providerAccepted` — non-ACK
- `sendStatus: accepted` — non-ACK
- `sendStatus: sent` — non-ACK

---

## 5. Cross-reference to existing contracts

| Adapter capability | Maps to receipt level | Relevant existing invariant |
| --- | --- | --- |
| C1 — `produced` | 0 (no evidence) | None — pre-send state, not covered by existing contracts |
| C2 — `spooled` | 0 (no evidence) | Hermes spool semantics apply if the spool is Hermes-compatible; otherwise no existing coverage |
| C3 — `provider_only` | 1 — accepted-send | `providerAccepted`/`providerMessageId` are non-ACK; `terminal-evidence-ack-boundary.md` §nonAckSignals |
| C4 — `requester_visible` | 2 — requester-visible receipt | GitHub comment projection is an example; `terminal-semantics.md` §requester-visible receipt |
| C5 — `operator_visible` | 3 — operator-visible receipt | `terminal-semantics.md` §operator-visible receipt; `terminal-brief-core-contract.md` §4 |
| C6 — `operator_confirmed` | 4 — terminal ACK | `terminal-brief-core-contract.md` §4 ACK eligibility; requires `manual_operator_receipt` or `current_session_visible` |

---

## 6. Adapter contract verification

### 6.1 Conformance check

```bash
# Validate adapter-receipt-capability fixture against contract rules
node test/conformance/check-adapter-receipt-capability.mjs
```

### 6.2 Manual verification checklist

| # | Check | How | Fail-closed |
| --- | --- | --- | --- |
| A1 | Capability levels match existing receipt levels | Each adapter level (C1–C6) maps to a valid receipt level (0–4), and no new receipt level is introduced | Block if receipt level outside {0, 1, 2, 3, 4} |
| A2 | Non-ACK invariants preserved | Provider-only evidence (C3) always maps to level 1, not 4; `providerAccepted`/`providerMessageId` labeled non-ACK | Block if promotion detected |
| A3 | ACK mutation claimed by non-OpenClaw adapter | `terminalOutboxAckMutated` must be `false` for all adapter-level evidence | Block if `true` |
| A4 | C6 requires receipt proof | `ackSafeReceiptProof` must be present when `adapterReceiptLevel` is `operator_confirmed` | Block if missing |
| A5 | No skip-to-ACK | Evidence at C3 must not claim receipt level 4 or C6 | Block if adapter jumps from provider-only to ACK |
| A6 | Monotonicity | Evidence ordering: C1 < C2 < C3 < C4 < C5 < C6 | Block if out of order |
| A7 | Adapter evidence and fixture compatibility | Fixture scenarios align with contract definitions | Block if fixture contradicts contract |

### 6.3 Fixture

Machine-readable fixture: `fixtures/contract/adapter-receipt-capability.json`

---

## 7. Safety gates

### 7.1 Prohibited actions (same as core contract)

This contract is source-only and does not authorize:

- Production deploy or restart of any Gateway, broker, or worker service.
- Live provider/Telegram canary or notification send outside approved GitHub comments.
- Production DB mutation, terminal-outbox ACK mutation, or historical outbox replay.
- Release, tag, or npm publish.
- Secret rotation, movement, or disclosure.
- Repository visibility change, force-push, or history rewrite.

### 7.2 Adapter-specific safety gates

| Gate | Condition | Fail-closed |
| --- | --- | --- |
| Adapter reported `terminalOutboxAckMutated: true` | Block — non-OpenClaw adapter must not claim ACK mutation | Block immediately |
| Adapter evidence at C3+ used as ACK justification without explicit approval | Block — operator approval required for ACK | Block |
| Adapter claims C6 without C5 evidence | Block — skip-to-ACK violation | Block |
| Adapter reports `adapterType: "hermes"` or `adapterType: "openclaw-gateway"` for non-OpenClaw scope | Block — these are excluded adapter types | Block |

---

## 8. Residual risk

| Risk | Description | Mitigation | Fail-closed |
| --- | --- | --- | --- |
| Adapter may silently skip levels in internal state machine | Contract requires reporting capability level; silent skip can mask C3→C6 jumps | Evidence inspection; operator review of adapter logs | Block if log evidence contradicts reported level |
| Adapter `providerMessageId` reused across different capability levels | Inherited risk from existing contracts; applies to any adapter | Label with acksend-only disclaimer per ACK boundary contract | Block if reused as ACK proof |
| Adapter reports `spooled` (C2) but spool is non-durable | `spooled` implies durability beyond process lifetime; non-durable storage is actually `produced` (C1) | Adapter documentation must specify spool durability semantics | Block if adapter claims C2 with ephemeral storage |
| Non-OpenClaw adapter reports `requester_visible` (C4) without verifiable requester channel visibility | Adapter may misinterpret provider-delivery as requester visibility | C4 requires requester-visible channel evidence (e.g., GitHub comment URL); provider-delivery-ack alone is C3 | Block if provider-ack is promoted to C4 |
| Third-party adapter may inadvertently implement ACK mutation | Contract forbids it; but adapter in the wild may violate | This contract is a specification; enforcement depends on broker gate review | Block if adapter evidence shows ACK mutation |
| Adapter may confuse `spooled` (C2) with requester-visible (C4) | Spool prefix may lead to overconfidence | C2 explicit mapping to receipt level 0 | Block if C2 promoted to receipt level ≥1 |

---

## 9. Safety confirmation block

```
This lane:
- Did not deploy or restart any Gateway, broker, or worker service.
- Did not mutate production databases or terminal-outbox ACK rows.
- Did not send any live provider or Telegram message outside approved GitHub comments.
- Did not perform manual Terminal Brief ACK/replay or historical outbox replay.
- Did not change secrets, repository visibility, or release state.
- Did not rewrite history or force-push.
- Did not execute approval without fresh explicit operator approval.
- Provider accepted/message-id evidence is provider-accepted evidence only.
- Redacted repository evidence only (contracts, fixtures, test output).
- Runtime/bootstrap hygiene confirmed before evidence publication.
- No non-OpenClaw/Hermes/spool adapter was deployed or activated by this lane.
- Adapter receipt capability contract is source-only documentation and fixture evidence.
```

---

*This contract is source-only. It defines the receipt capability model for non-OpenClaw/Hermes/spool
Terminal Brief adapters. No adapter implementation, provider send, terminal-outbox ACK, DB mutation,
or any prohibited action is authorized by this document.*
