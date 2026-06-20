# A2AD Round Dispatch — canonical PR-review round workflow

`scripts/a2a-dispatch-round.mjs` is the first-class, manifest-driven round-dispatch
CLI. It replaces fragile shell/Python string-interpolation wrappers that built
broker requests with heredocs. Every prompt and message lives as a plain string
in a JSON manifest, so there is **zero shell interpolation** in the dispatch path.

> Canonical home: this monorepo (`a2a-nexus`) is the canonical source for the
> round-dispatch tooling. The archived split-repo mirrors are not canonical and
> must not be edited or relied on for dispatch.

## Why this exists

Two incidents motivated this tool:

1. **A failed round looked dispatched.** A review round
   (`pr-review-r2-20260612-195514`) was dispatched via a shell wrapper that built
   Python heredocs. Quoting broke (`SyntaxError: unterminated triple-quoted
   string literal`), the child processes failed, yet the wrapper still printed
   `ALL DISPATCHED`. A failed round was reported as successful.
2. **Ambiguous broker acks.** Broker task creation sometimes answered
   `{"error":{"code":"queue_drain_timeout"}}` even though the task **was** created
   in memory — only the durable-persistence ack timed out. The operator could not
   tell *rejected* from *accepted-but-unconfirmed* from *duplicate*.

This CLI is **fail-closed**: it never prints an all-clear when anything failed,
classifies each lane explicitly, and the forbidden banner string `ALL DISPATCHED`
appears nowhere in the tool.

## Manifest schema

```jsonc
{
  "roundId": "pr-review-r2-20260612-195514",   // required, non-empty
  "brokerUrl": "https://broker.example",        // required, non-empty
  "requester": { "id": "libero", "role": "orchestrator" }, // required
  "defaults": {                                 // optional
    "intent": "pr-review",                      // lane intent fallback
    "payload": { "...": "..." }                 // merged under each lane payload
  },
  "lanes": [                                    // required, non-empty
    {
      "id": "optional-explicit-id",             // optional; see lane ids below
      "target": { "id": "worker-1", "role": "reviewer" }, // required
      "assignedWorkerId": "worker-1",           // optional
      "intent": "pr-review",                    // optional if defaults.intent set
      "message": "Please review PR #123 ...",   // required, non-empty plain string
      "payload": { "...": "..." }               // optional, merged over defaults.payload
    }
  ]
}
```

- The edge secret is **never** part of the manifest or a CLI flag. It is read
  from the `A2A_EDGE_SECRET` environment variable only, and is never logged.
- Each lane's payload is auto-stamped with `parentRoundId` (= `roundId`),
  `parentRoundTotal` (= `lanes.length`), and `parentRoundOrder` (1-based) unless
  the manifest sets those fields explicitly.
- Each create-task body is also auto-stamped with top-level `parentRoundId`,
  `parentRoundTotal`, and `parentRoundOrder` so brokers that validate round
  metadata outside `payload` see the same values.

### GitHub verify / read-only validation lanes

For `payload.mode` equal to `github-verify`, `github-read-only-validation`, or
`read-only-analysis`, dry-run validates the broker-required GitHub task contract
before any `POST /tasks` call:

- `taskOrigin: "github"` at lane/defaults level;
- `workspace.workspaceId` at lane/defaults level, and `workspace.nodeId` matching the target worker node for each dispatched lane. If a GitHub lane inherits `defaults.workspace` and does not set `lane.workspace`, the CLI derives the lane workspace by preserving `workspaceId` and stamping `nodeId` from `lane.target.id`; an explicit lane workspace whose `nodeId` disagrees with the target fails closed before POST.
- `payload.workModeDecision` with `mode` of `team1` or `hybrid`, stable
  `idempotencyKey`, finalizer/capacity fields, `sourceOnlyDecision: true`, and
  `workerDispatchAllowedByThisPacket: false`;
- `payload.originBrokerId`, `payload.brokerOfRecordId`, and
  `payload.operatorFacingOwner`;
- `terminalBrief.notificationOwnership` at lane/defaults level.

The dispatch body passes those fields through at top level and `--verify`
re-fetches the created task by id, giving a deterministic readback gate without
printing secrets.

When the worker handler is run with the explicit analysis bridge enabled
(`A2A_OPENCLAW_ANALYSIS_ENABLED=1` and a configured OpenClaw/analysis binary),
these GitHub read-only validation modes route to the read-only analysis bridge
instead of the generic GitHub patch executor path (#884). If the bridge/executor
is not configured, the handler still fails closed rather than returning generic
wrapper-only success.

### Pure A2AD source-only/no-live analysis lanes

For `intent: "analyze"` + `payload.mode: "analysis-only"` lanes with
`payload.roundMode: "a2ad"`, `payload.sourceOnly: true`, and
`payload.noLive: true`, dry-run also validates the live-broker ownership packet
before any `POST /tasks` call (#963):

- `payload.originBrokerId` identifies the originating broker for the parent round;
- `payload.brokerOfRecordId` identifies the broker responsible for recording the lane;
- `payload.operatorFacingOwner` identifies who owns operator-visible closeout;
- `terminalBrief.notificationOwnership` lives at lane/defaults level and declares
  notification/finalizer ownership for Terminal Brief handling.

A valid source-only/no-live A2AD manifest should put shared values under
`defaults.payload` and `defaults.terminalBrief`, then let lane-specific payload
fields such as `focus` or `parentRoundOrder` override only the narrow per-lane
parts. Missing ownership metadata fails closed in `--dry-run`, so the live broker
is not the first place the operator sees the error.

### GitHub patch lanes are write-capable

`payload.mode: "github-propose-patch"` is a PR/patch execution lane, not a
read-only evidence lane. It may create GitHub comments, branches, or pull
requests even if the free-text worker prompt says "proposal only" or "do not
mutate GitHub". Prompt text is not a safety boundary.

Dry-run therefore fails closed before `POST /tasks` when
`github-propose-patch` is paired with no-write/read-only signals such as
`payload.readOnlyValidation: true`, `payload.noGitHubWrites: true`,
`payload.noMutation: true`, `payload.allowGitHubWrites: false`, or
`payload.patchIntent: false` (#889). Use `read-only-analysis` /
`github-read-only-validation` for analysis-only evidence, and reserve
`github-propose-patch` for an explicit PR-first patch lane.

### Deterministic lane ids (idempotency)

If a lane omits `id`, the CLI derives `${roundId}:${order}` (1-based order). This
makes re-running the same manifest **idempotent**: a re-dispatch that the broker
rejects as a duplicate is confirmed via `GET /tasks/:id` and classified as
`already-exists` rather than `failed`.

## Broker request contract

For each lane the CLI issues a sequential `POST /tasks` (one at a time, to avoid
the queue-drain stampede) with:

- Body (`CreateTaskRequest`): `{ id, intent, requester:{id,kind,role},
  target:{id,kind,role}, assignedWorkerId?, message, payload,
  parentRoundId, parentRoundTotal, parentRoundOrder, taskOrigin?, workspace?,
  terminalBrief? }`.
- Headers: `x-a2a-edge-secret`, `x-a2a-requester-id`, `x-a2a-requester-role`.

Confirmation reads use `GET /tasks/:id` with the same auth headers.

## Lane classification

| Classification         | When |
|------------------------|------|
| `created`              | `201`/`200`/`202` returning a task body |
| `accepted-unconfirmed` | `202 {durable:false}` / `202 {ackTimeout:true}`, **or** `503 queue_drain_timeout` / `queue_saturated` where a follow-up `GET /tasks/:id` finds the task. Includes a verify hint. |
| `already-exists`       | `409` conflict where `GET /tasks/:id` finds the task (idempotent re-run) |
| `failed`               | anything else, including `503` where the task is **not** found. Records HTTP status + error code. |

The CLI handles **both** broker response shapes for the durable-ack-timeout case:

- legacy: HTTP `503` with `{ error: { code: "queue_drain_timeout" } }`, and
- new: HTTP `202` with `{ task, durable:false, ackTimeout:true }`.

### queue_drain_timeout semantics

`queue_drain_timeout` (and `queue_saturated`) does **not** mean the task was
rejected. The task may already exist in broker memory while the durable-persistence
ack timed out. The CLI therefore does a confirming `GET /tasks/:id`:

- task found → `accepted-unconfirmed` (counts toward a clean round) plus a verify
  hint telling the operator to re-check durability later;
- task not found → `failed`.

Run with `--verify` to re-fetch every lane after dispatch and print a round status
table with per-state counts.

## Fail-closed exit contract

```
exit 0  ONLY when every lane is created / already-exists / accepted-unconfirmed
        AND (created + already-exists + accepted-unconfirmed) == lanes.length
exit 1  if ANY lane is failed (or the manifest is invalid)
```

No all-clear banner is printed when anything failed. The literal string
`ALL DISPATCHED` is never emitted.

## Usage

```bash
# Validate the manifest and print the would-create table; no network.
npm run dispatch:round -- --manifest round.json --dry-run

# Dispatch the round (secret from env), human-readable summary table.
A2A_EDGE_SECRET=... npm run dispatch:round -- --manifest round.json

# Dispatch and then re-fetch each lane to print a round status table.
A2A_EDGE_SECRET=... npm run dispatch:round -- --manifest round.json --verify

# Machine-readable output.
A2A_EDGE_SECRET=... npm run dispatch:round -- --manifest round.json --json
```

`--dry-run` validates schema, unique lane ids/orders, and non-empty messages,
then prints the planned table without any network call.

## Safety

This command creates broker tasks (the dispatch itself). It never deploys,
restarts Gateway/brokers/workers, mutates DB/outbox state beyond task creation,
ACKs/replays Terminal Brief records, releases or tags, or moves secrets. The edge
secret is never written to stdout or stderr.

## Tests

`scripts/a2a-dispatch-round.test.mjs` (node:test) exercises the full contract
against a local `node:http` mock broker, including: all-201 → exit 0; one-500 →
exit 1 with the other lanes still attempted; `503 queue_drain_timeout` with and
without a confirming `GET`; the `202 {durable:false}` shape; duplicate →
`already-exists`; dry-run rejection of duplicate lane ids, empty messages, invalid
source bundles, and incomplete GitHub verify manifests; POST passthrough of
GitHub verify top-level schema fields; and a child-process assertion that the
secret and the forbidden banner never appear in output.

```bash
npm run dispatch:round:test
```
