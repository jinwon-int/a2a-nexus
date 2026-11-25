# MCP Tasks facade contract

> Status: contract v0 (no-live). Tracking: [#2591](https://github.com/jinwon-int/a2a-nexus/issues/2591)
> (mapping [#2592](https://github.com/jinwon-int/a2a-nexus/issues/2592), operator-decision gate
> [#2593](https://github.com/jinwon-int/a2a-nexus/issues/2593)).
> Code: `packages/broker/src/a2a/mcp-tasks-facade.ts`, tests `mcp-tasks-facade.test.ts`.

This contract fixes how a broker task is presented to an MCP client through the
**MCP Tasks** extension, and which `tasks/update` input the facade may accept.
It is pure mapping: it defines no MCP server process, transport, authentication,
or deployment. A later live adapter must call these functions and must not
re-derive the mapping.

## Sources

Checked 2026-11-25:

- MCP Tasks wire shape and client behavior: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
  (Tasks section; protocol revision 2026-07-28; GA in Claude Code 2026-11-24).
- Announcement: [Skills over MCP, Tasks and more](https://claude.com/resources/articles/skills-over-mcp-tasks-and-more).
- Broker vocabulary: `TaskStatus`, `TaskCheckpointState`, `TaskInterruptDecisionType` in
  `packages/broker/src/core/types.ts`; checkpoint semantics in
  [`contracts/a2a/checkpoint-interrupt.md`](../../contracts/a2a/checkpoint-interrupt.md).

The MCP Tasks extension specification itself was not read for this version;
field names follow the Claude Code documentation. Re-check them against the
extension specification before building the live adapter.

## Status mapping

The MCP status is derived from the existing A2A projection (`mapTaskState` in
`task-projection.ts`), so the A2A and MCP faces of a task cannot drift apart.

| Broker status / checkpoint | A2A state | MCP `status` | Input kind |
|---|---|---|---|
| `queued` | `submitted` | `working` | — |
| `claimed`, `running` | `working` | `working` | — |
| `claimed`, `running` + checkpoint `paused` | `working` | `working` | — |
| `claimed`, `running` + checkpoint `awaiting_operator`, decision `ambiguous_scope` | `input-required` | `input_required` | `clarification` |
| `claimed`, `running` + checkpoint `awaiting_operator`, any other or no decision type | `input-required` | `input_required` | `operator_decision` |
| `blocked` (approval-gated) | `auth-required` | `input_required` | `operator_decision` |
| `succeeded` | `completed` | `completed` | — |
| `failed` | `failed` | `failed` | — |
| `canceled` with `approvalOutcome.status: "rejected"` | `rejected` | `failed` | — |
| `canceled` | `canceled` | `cancelled` | — |

- **Spelling:** the broker and A2A write `canceled`; MCP writes `cancelled`.
  An MCP cancel request maps back to broker `canceled` (`MCP_CANCEL_BROKER_STATUS`).
- **Exhaustiveness:** the tests read the three unions from `types.ts` and
  compare them with the expected table. A new status, checkpoint state, or
  decision type without a mapping fails CI. The A2A → MCP switch is also
  exhaustive at compile time.
- **Correction to #2592's draft table:** the draft listed `completed` and
  `expired` as broker statuses. The broker's `TaskStatus` is
  `blocked | queued | claimed | running | succeeded | failed | canceled`; there
  is no `expired` task status (expiry exists only as an approval outcome).

## Fields

| MCP field | Value |
|---|---|
| `taskId` | The broker task id, verbatim. It must be 1..128 printable ASCII characters (0x20-0x7E). Any other id is **rejected** (`McpTaskIdError`), never rewritten, so the id stays a lossless reference. |
| `status` | From the table above. |
| `statusMessage` | Closed-vocabulary tokens only: `broker:<status>`, `checkpoint:<state>`, `decision:<type>`, `approval:<outcome>`. Never checkpoint `reason`, task text, or result text, so nothing needs redaction. Capped at 160 characters. |
| `createdAt` / `lastUpdatedAt` | Task `createdAt` / `updatedAt`. |
| `ttlMs` | `null`: the broker does not expire tasks on a TTL. |
| `pollIntervalMs` | Clamped to 250..30000, default 2000. |
| `inputRequests` | Present only for `input_required`, with exactly one key: `clarification` or `operator_decision`. |

## Operator decisions are never answered through `tasks/update`

In MCP Tasks a client answers `input_required` with
`tasks/update { taskId, inputResponses }`. Claude Code forwards an
`elicitation/create` to a person only in an interactive terminal session. In an
unattended session (bridge, cron, SDK) the client, and so the model, fills
`inputResponses` itself. If the facade accepted an answer to an approval wait,
the player would act as the judge ([trust boundaries](../trust-boundaries.md),
"Judge is not player").

Rules:

1. An `operator_decision` wait rejects **every** `tasks/update` payload with
   `operator_decision_out_of_band`. This includes `true`, `"approve"`, a localized approval word,
   a well-formed elicitation result, and any approval id (genuine or forged).
2. The only way past an operator decision is the broker's own operator route:
   `approveTask` for an approval-gated (`blocked`) task, which enforces a hub or
   operator actor, or the operator checkpoint decision for an
   `awaiting_operator` checkpoint. The MCP status changes on the next
   `tasks/get` because the broker state changed. The facade never mutates the
   broker.
3. A rejection returns a reason code only. It echoes no part of the payload
   and no checkpoint text.
4. The classification is deny by default. Only `ambiguous_scope` is a
   clarification. `approval_required`, `safety_gate`, `conflict_detected`, and
   a checkpoint with no decision type (the broker defaults it to
   `approval_required`) are operator decisions.
5. A `clarification` wait accepts exactly one key (`clarification`) whose value
   is an elicitation result with `action: "accept"` and a non-empty
   `content.text` of at most 4000 characters (trimmed). `decline`/`cancel`,
   extra keys, and malformed content are rejected. Accepting a clarification
   only classifies it; delivering it (for example as a context message) goes
   through the broker's existing task-party authorization.

**Deviation from #2593's draft:** the draft allowed a reference to an existing
approval record in `inputResponses`. This version accepts none. Once an operator
has approved through the broker, the task is no longer waiting, so a reference
adds no capability. Accepting one would only add a verification path an attacker
could probe.

## Non-goals

- MCP server process, transport (HTTP/stdio), authentication, and deployment.
- Turning MCP Tasks on in worker lanes. Lanes stay one-shot `claude -p` runs
  with `--strict-mcp-config` and an env allowlist, pinned by tests since #2594.
- Skills over MCP.
