# R6 Terminal Brief OpenClaw routing no-bypass synthesis

Issue: #87 (a2a-plane#87, internal tracker private)
Parent: #83 (a2a-plane#83, internal tracker private)
Upstream context: [`openclaw/openclaw#78261`](https://github.com/openclaw/openclaw/pull/78261) — closed/superseded by maintainer decision

## Decision

**Done synthesis / activation remains blocked.** It is safe for A2A Nexus to prepare Terminal Brief notice plumbing around OpenClaw CLI/Gateway/outbound lifecycle abstractions, but unsafe to use that plumbing as a terminal ACK path from provider accepted-send evidence or provider message ids alone. `openclaw/openclaw#78261` is no longer a merge/runtime gate after maintainer close.

`providerAccepted`, provider send success, Telegram message ids, or Gateway outbound success are **provider accepted-send / notice transport evidence only**. They must remain non-ACK and must not close Terminal Brief receipt gaps.

## Evidence reviewed

- `#75` R5 originally deferred Terminal Brief/source closeout until `openclaw/openclaw#78261`; after maintainer close, that dependency is superseded by A2A-owned terminal evidence/replay-safety/operator-approval gates.
- `#83` R6 parent allows OpenClaw routing preparation only as no-bypass best-effort notice plumbing.
- `#84`, `#85`, and `#86` had Start evidence only at this snapshot; no sibling PR/Done/Block outputs were available to count as passing gates.
- `openclaw/openclaw#78261` was later closed by maintainers; maintainer guidance treats Telegram provider message id as accepted-send evidence while keeping read/visibility separate.
- Current repo guardrails already state the core boundary:
  - `contracts/a2a/terminal-semantics.md` says provider-send success is not ACK evidence.
  - `contracts/a2a/broker-handoff-protocol.md` says terminal evidence relay does not ACK terminal outbox rows.
  - `packages/openclaw-plugin-a2a/docs/operator-terminal-notification-receipts.md` requires current-session/user-visible or manual receipt before terminal notification ACK.
  - `packages/openclaw-plugin-a2a/src/operator-notification-adapter.ts` skips live sends when the runtime does not advertise current-session-visible receipt support and rejects provider-only results as missing receipt confirmation.
  - `packages/broker/scripts/terminal-brief-activation-report.mjs` keeps code merge, send evidence, operator-visible receipt, manual ACK, and no-live restoration as separate gates.

## Unsafe bypass patterns to reject

Do not merge or run changes that do any of the following:

1. Treat `providerAccepted`, `accepted`, `sent`, Telegram `messageId`, or generic Gateway send success as `current_session_visible`, `operator_visible`, `receipt_confirmed`, or terminal ACK evidence.
2. Call Telegram Bot API directly, shell out to `curl`, or add ad-hoc provider delivery for Terminal Brief notices instead of using OpenClaw routing/outbound lifecycle seams.
3. Enable live Terminal Brief notification by default, send historical/backlog Terminal Brief rows, or bypass the one-shot/fresh-task guard.
4. Mutate broker terminal-outbox ACK state from a provider send callback or from a PR/Done/Block GitHub evidence relay.
5. Paste provider ids, Telegram ids, OpenClaw runtime/bootstrap files, raw session dumps, secrets, or host-specific paths into issue/PR evidence.

## Follow-up gates before activation

Proceed only after all gates are satisfied and linked from the parent issue:

1. A2A Nexus contract/tests map provider message id and send success as provider accepted-send evidence only, not ACK.
2. A follow-up proof shows manual operator receipt or an explicit ACK-safe receipt path for the Terminal Brief route. Provider acceptance/message id alone is insufficient.
3. R6 sibling lanes finish with PR/Done/Block evidence:
   - broker contract rejects direct Telegram/curl Terminal Brief paths;
   - plugin bridge uses OpenClaw routing/outbound lifecycle and remains ACK fail-closed without current-session-visible proof;
   - CI/static guard prevents regressions into direct provider sends or providerAccepted-as-ACK.
4. A no-live preflight proves runtime/config readiness without deploy, Gateway restart/reload, provider send, DB mutation, terminal ACK, source visibility change, or secret rotation.
5. Any live proof is explicitly operator-approved, one-shot, tied to a fresh task/outbox id, and records manual/proven ACK-safe receipt before ACKing that exact id.
6. After proof, no-live defaults are restored and evidence is redacted; runtime/bootstrap context files must not enter the branch or artifacts.

Until these gates pass, the correct Terminal Brief closeout status is **Block / waiting on A2A terminal evidence and replay-safe canary proof**, not live notification or ACK activation.
