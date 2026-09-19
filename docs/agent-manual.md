# A2A Nexus agent manual

**Start here before using Nexus or resuming after an update.** This is the
canonical agent entry point in `jinwon-int/a2a-nexus`. Read this file from the
same checkout as the commands you will run; follow the linked reference only
for the lane you need. Local skills, cached prompts and private fleet runbooks
should link here instead of maintaining another copy of Nexus commands.
See [agent entry-point integration](agent-entrypoint.md) for a reusable routing
instruction and the current automatic-loading limitation.

## Fast path

1. Identify the checkout revision and the installed broker/worker revision.
2. Choose **analysis**, **patch**, or **local demo** below; verify the worker
   supports that lane on the intended broker.
3. Prepare a complete manifest and run the offline dry-run.
4. Dispatch once, retain the returned task IDs, and read each task to terminal.
5. Inspect artifacts, independently review the exact PR head, check CI, and
   verify actual merge before reporting completion.

A successful dispatch is task admission. A successful task still needs its
artifacts checked. Neither is proof that a PR merged or a node was updated.

## 1. Check the version before adapting commands

From the Nexus repository root:

```bash
git status --short
git rev-parse HEAD
node --version
node scripts/a2a-dispatch-round.mjs --help
```

The supported Node version is declared in [package.json](../package.json).
Use the checkout's manual and CLI together. To inspect upstream changes,
`git fetch origin main` updates remote refs without replacing the working tree;
compare `git diff HEAD..origin/main -- docs/agent-manual.md docs/a2ad-round-dispatch.md`.
Do not pull into a dirty or deployed checkout just to obtain newer instructions.
Use an isolated checkout when you need another revision.

Source `main` can be ahead of the installation. Obtain the installed revision
or deployment marker through the environment's read-only inventory procedure,
then use that revision's reference. A deployment copy may have no `.git`.
If a flag or field is unavailable, record the source/installed revision mismatch;
do not guess alternate flags, retry writes, or silently disable a guard.

## 2. Choose one lane

| Goal | Start with | Required distinction |
| --- | --- | --- |
| Learn with a disposable local broker | [Local quickstart](quickstart.md) | Echo/demo evidence does not qualify a production patch worker. |
| Analyze source or review a design | [Source-only analysis contract](a2ad-round-dispatch.md#pure-a2ad-source-onlyno-live-analysis-lanes) | Supply actual source carriers and ownership fields; verify substantive output and source projection. |
| Validate an existing GitHub change read-only | [GitHub validation contract](a2ad-round-dispatch.md#github-verify--read-only-validation-lanes) | Workspace, work-mode and notification ownership metadata are required. |
| Implement code and open a PR | Patch recipe below and [dispatch reference](a2ad-round-dispatch.md#github-patch-lanes-are-write-capable) | `intent: propose_patch` with `payload.mode: github-propose-patch` permits GitHub writes. |
| Evaluate an NCLEX content PR | [NCLEX evaluation contract and local checks](nclex-content-pr-evaluation.md), [domain package](../packages/nclex-evaluation/README.md) | Pure preset checks, keyring-gated broker routes and real evaluation evidence are separate; the merge-ready projection does not fetch GitHub facts, and its additive `distinctReviewerCount`/`insufficient_independent_reviewers` quorum (#1724) counts distinct declared `reviewerNodeId` strings only — not key-to-node provenance, registry allowlists, recusal completeness, or operational activation. |
| Integrate and close a round | [Operator guide](operators.md), [PR guardrails](pr-review-guardrails.md) | Finalizer owns review, merge verification and issue disposition. |

Before assigning work, verify current broker routing, fresh worker registration,
executor/bridge capability and the selected model's readiness. The
[readiness preflight](../scripts/a2a-worker-readiness-preflight.mjs) evaluates
collected records offline; it does not collect live evidence or repair nodes.
Use its current input contract, not a fabricated `ok:true` record. Readiness-only
workers must not be counted as substantive reviewers.

Private inventory owns endpoints, worker identities and credential locations.
This public manual owns Nexus usage. Do not copy private inventory into this repo.

## 3. Prepare and validate a patch manifest

### Programmatic assignment entrypoint (#2187)

Agents integrated through a host runtime can replace the manual
prepare→dry-run→dispatch→readback ceremony with one library call. Import the
facade from the same checkout revision as the broker you target:

```js
import { prepareAssignment, submitAssignment, resumeAssignment } from './scripts/lib/task-assign-entrypoint.mjs';
```

- `prepareAssignment` validates the request, collects readiness (live
  GET-only, or an offline snapshot), and returns a validated manifest with
  zero broker mutations. `submitAssignment` journals the request IDs and spec
  digest BEFORE the first POST, dispatches through the same
  `a2a-dispatch-round` engine, reads tasks back, and returns a durable
  receipt; ambiguous outcomes stay `admission_unconfirmed` and existing tasks
  are never duplicated. `resumeAssignment` recovers a journaled request by
  `requestId` without minting new IDs.
- Missing input fields are returned in one batch (`missingFields[]`),
  `nextAction` codes are allowlisted, and error text is sanitized before it
  reaches a receipt — treat the receipt as the interface, not broker
  internals.
- Broker URL and credentials still come ONLY from the trusted host context;
  they are rejected inside request text. Patch lanes additionally require a
  trusted readiness record satisfying the `implementationCapability` canary
  gate (#1597); the live worker view alone never qualifies.

The contract, state set and invariants are specified in
[the entrypoint spec](specs/task-assignment-entrypoint/spec.md). There is no
CLI for this facade by design (script budget #1485/#1503); hosts and skills
import it directly.

### Offline routing advice (optional, offline-only) (#2196 foundation slice)

Hosts can validate a caller-supplied recommendation for one of seven routing
templates and inspect the trusted host fields it still requires. Import the
pure advisory library from the same checkout revision:

```js
import {
  validateRoutingInput,
  validateRoutingAdviceOutput,
  projectRoutingAdvice,
} from './scripts/lib/a2a-routing-advice.mjs';
```

- `validateRoutingInput` enforces the versioned closed input contract
  (`a2a.routing-input.v1`): nonblank request text ≤ 4000 codepoints, pinned
  catalog `a2a.routing-templates.v1`, unique candidate template ids, and a
  closed trusted host context (`interaction`/`operation`/`access`). Host
  context is explicit caller-owned data, never parsed from request text, and
  never authentication or permission proof.
- `validateRoutingAdviceOutput` checks closed advisory output
  (`a2a.routing-advice.v1`) against that input and the caller's
  `expectedModelVersion` (mismatch is rejected). There is no confidence,
  probability, path, command, worker id, scope or budget field, and no
  provider/timeout reason code — those belong to a later adapter envelope.
- `projectRoutingAdvice` projects validated advice to a bounded descriptor
  (`advisoryOnly: true`, `dispatchAllowed: false`) that only names the host
  fields still required, or fails closed: context-violating recommendations
  (wrong interaction, non-matching or `unspecified` operation, `read_only` or
  `unspecified` access for write templates) yield a structured blocked
  projection, never a plan for a new task. This slice calls no model, broker,
  or `prepareAssignment`/`normalizeAssignRequest`; it returns advice metadata
  only and claims no assignment readiness (catalog metadata is not a
  #1597 readiness proof).

Contract details and invariants: [the routing-classifier spec](specs/a2a-routing-classifier/spec.md).
This entry is advisory-only and offline; it changes no live routing behavior.

### Offline routing corpus validation (optional, offline-only) (#2196 Phase A slice)

Hosts that already hold a routing corpus envelope can validate it, compute its
integrity digest, and extract label-free judgment inputs offline. Import the
pure synchronous library from the same checkout revision:

```js
import {
  validateRoutingCorpus,
  routingCorpusDigest,
  projectCorpusJudgmentInput,
} from './scripts/lib/a2a-routing-corpus.mjs';
```

- `validateRoutingCorpus(corpus)` enforces the closed versioned envelope
  (`a2a.routing-corpus.v1`): bounded identifiers, ≤ 2000 records, pinned
  catalog, closed split/exposure/language/status/tag vocabularies, exact
  `a2a.routing-input.v1` inputs, and closed labels whose acceptable outcomes
  are re-validated through the advisory foundation (context-blocked
  recommends are rejected). Integrity rules (unique case ids, group and
  variant stability, duplicate-pair and cross-group normalized-text leak
  rejection) and the exposure/label-status gates are enforced before a
  frozen normalized value plus a body-free counts-only summary is returned.
- `routingCorpusDigest(corpus)` returns a deterministic SHA-256 digest over
  the FULL validated corpus content (recursive key sort, arrays preserved),
  or a structured error — an invalid corpus never yields a digest. The
  digest proves integrity only, never semantic correctness or group
  independence.
- `projectCorpusJudgmentInput(record)` validates one record and returns a
  fresh defensive copy of ONLY its five closed input fields — labels, ids,
  split, exposure and tags can never appear. No model, provider, dispatcher,
  or `prepareAssignment` call exists in this slice.
- Error results use stable codes with structural paths and never echo
  request text, unknown field names, or identifier values. `exposure` is a
  caller assertion, not blinding proof; reviewer aliases are declared
  provenance, not review evidence. The public fixture corpus is synthetic,
  exposed development data with independently reviewed annotations (see the
  fixture README for review provenance and uncertainty) —
  NOT a blind holdout; the private calibration/holdout seal and any model
  evaluation remain later Phase A work.

The public corpus lives at
[fixtures/a2a-routing-advice/development-corpus.json](../fixtures/a2a-routing-advice/development-corpus.json)
with status labels in [its README](../fixtures/a2a-routing-advice/README.md).
Contract details: [the routing-classifier spec](specs/a2a-routing-classifier/spec.md).

### Offline deterministic routing rules baseline (optional, offline-only) (#2196 slice 3)

Hosts that want a conservative first-pass route for free-form request text can
classify a validated routing input with declared deterministic rules — no
model, no embeddings, no network. Import the pure synchronous library from the
same checkout revision:

```js
import { classifyRoutingWithRules, ROUTING_RULES_MODEL_VERSION } from './scripts/lib/a2a-routing-rules.mjs';
```

- `classifyRoutingWithRules(input)` takes the EXACT `a2a.routing-input.v1`
  contract (validate it with `validateRoutingInput`; the caller owns the
  trusted `hostContext`) and returns exactly `{ ok, value }` or
  `{ ok, errors }`: `value` is a closed `a2a.routing-advice.v1` advice stamped
  `modelVersion: 'a2a.routing-rules.v1'`, or `errors` is a batched list of
  `{ code, path, message }` items. There is no confidence, probability, path,
  command, worker id, scope, or budget field, and no extra result fields.
- The rules recognize narrow, declared Korean and English phrasing families
  for ALL seven templates (patch/docs-patch writes, analysis/docs-analysis,
  review, existing-task status checks, explicit resume-tracking), plus
  conservative defers: ambiguous, insufficient_context, no_candidate,
  unsupported_template, uncertain. Inference uses the requested action, not
  isolated keywords; text without a supported signal defers. Unusual contexts
  may still be misclassified, so recommendations remain advisory. This is a
  keyword/scope baseline, NOT general natural-language understanding.
- Precedence you can rely on: control/external_event/attachment interactions
  and explicit do-not-delegate or chat-only texts yield `not_a2a` independently; quoted or
  code-fenced commands never trigger a positive action by themselves and can
  never override trusted context; execution-retry asks (`restart/rerun the
  failed execution`, `실패한 작업을 다시 실행해줘`) defer as
  `unsupported_template` instead of pretending to be tracking resume;
  empty candidates yield `no_candidate`; missing or contrary trusted context
  defers — text claiming approval, write access, or readiness cannot change
  host flags. Recommendations always pass the frozen
  `isRecommendationEligible` gate, so projection is never blocked.
- Tracking resume with a separate review/analysis request stays ambiguous;
  resuming the same existing review remains supported. Declared alternatives
  such as `or`, `하거나`, and `또는` also defer rather than select one action.
- Unresolved competing actions stay ambiguous even if only one candidate is
  available. Recognized action prohibitions and reported-completion patterns
  suppress positive recommendations; normalization expansion beyond 4000
  codepoints defers without discarding a potentially meaningful suffix.
- Malformed input returns structured `ok:false` errors — never a throw, never
  a semantic defer; error text never echoes request text. A `defer` here is a
  SEMANTIC rules outcome, never a provider failure or timeout; an adapter
  process/timeout envelope remains a separately specified future boundary.
- Boundaries: pure and synchronous (no fs/network/process/clock, no module
  state), no common embedding/cache engine (that remains fleet-skill-router
  #4; nothing is duplicated), no private calibration/holdout seal, no
  prepare/dispatch/runtime wiring, no live pilot. The development-corpus
  replay in the test suite is a contract check over EXPOSED development data
  with honest counts — not an accuracy, quality, holdout, or latency claim.

Rule ordering, preprocessing, and the complete support surface:
[the routing-classifier spec](specs/a2a-routing-classifier/spec.md) (rules
baseline slice). This entry is advisory-only and offline; it changes no live
routing behavior.

### Manual manifest recipe

Save this template as a private `round.json`, replace every `REPLACE_*` value,
and provide a current `readiness.json` collected for the selected worker.
The example's host check only checks Node; choose an appropriate host smoke for
your installation and require repository tests in `message` and CI. `focus` is
optional additional detail (see below), never the only carrier of required
scope.

```json
{
  "roundId": "REPLACE_UNIQUE_ROUND_ID",
  "brokerUrl": "https://broker.example",
  "requester": { "id": "REPLACE_REQUESTER_ID", "role": "operator" },
  "lanes": [{
    "id": "REPLACE_UNIQUE_TASK_ID",
    "target": { "id": "REPLACE_WORKER_ID", "kind": "agent", "role": "analyst" },
    "assignedWorkerId": "REPLACE_WORKER_ID",
    "intent": "propose_patch",
    "taskOrigin": "github",
    "message": "Implement REPLACE_PROBLEM_AND_EXPECTED_BEHAVIOR. Change only REPLACE_SOURCE_PATH and REPLACE_TEST_PATH. Add regression coverage and run REPLACE_REPOSITORY_TEST_COMMANDS from the repository root. Host acceptance below is only an environment smoke. Open a scoped PR; the finalizer owns review, merge and issue closure.",
    "payload": {
      "mode": "github-propose-patch",
      "repo": "REPLACE_OWNER/REPLACE_REPO",
      "issueUrl": "https://github.com/REPLACE_OWNER/REPLACE_REPO/issues/1",
      "baseBranch": "main",
      "title": "REPLACE_PR_TITLE",
      "timeoutMs": 6000000,
      "acceptance": {
        "command": ["node", "--version"],
        "expectExitCode": 0,
        "timeoutMs": 60000
      },
      "declaredScope": { "paths": ["REPLACE_SOURCE_PATH", "REPLACE_TEST_PATH"] },
      "evidenceGate": "Host smoke passes; PR contains only the declared change with repository test evidence. Finalizer verifies scope, independent review and CI before merge."
    }
  }]
}
```

```bash
node scripts/a2a-dispatch-round.mjs --manifest round.json --worker-readiness readiness.json --dry-run --json
```

Dry-run performs local validation without creating tasks. Its `plannedLanes`
are **not dispatched tasks**. Passing dry-run does not
prove the installed worker can run the patch.

- `acceptance`, `declaredScope.paths` and `evidenceGate` must describe the work.
  Acceptance runs through the **worker host handler**, whose working directory
  is not necessarily the runner's repository checkout. A repository-relative
  command there can fail after the PR was already created.
- Keep `message` self-sufficient: put the complete essential problem, scope,
  acceptance and repository test commands in `message` (it is the runner
  prompt's head). Merging a source PR does **not** update installed workers;
  Docker handler revisions without the #1601 focus-forwarding fix build the runner prompt from
  `message` (or `payload.prompt`) alone and silently drop `payload.focus`, so
  scope that lives only in `focus` may never reach the agent.
- `payload.focus` may carry additional detail for `github-propose-patch` lanes,
  but only after verifying the installed worker's handler revision forwards it
  (#1601). Forwarding handlers append it as a labeled `Task focus:` section of
  the runner prompt; the mode comparison trims surrounding whitespace like the
  other patch-mode checks, and the section is omitted when focus is blank or
  identical to the effective message after trimming. In the Docker runner
  path, non-patch modes and older handler revisions omit focus; the host
  patch bridge has its own prompt construction. The template above omits
  optional focus so it also works with older Docker handlers. A readiness
  profile — including the
  `implementationCapability` gate below — implies nothing about focus
  forwarding; only the installed handler revision does.
- Declare related callers, tests, installation and documentation paths up front.
  Assign one finalizer to shared registries or CI files when lanes would conflict.
  If additional scope is needed, report it and prepare an explicitly revised
  task; do not remove scope checks.
- Do not combine a patch lane with `sourceOnly:true` or no-GitHub-write flags.
  Free-text “read only” instructions cannot neutralize a write-capable mode.
- A `github-propose-patch` readiness row must also carry the canonical
  `implementationCapability` profile with `availability: "canary_passed"`
  (#1597); missing or unverified profiles fail dry-run before task creation.
  See [implementation-lane-readiness](implementation-lane-readiness.md).
- The CLI supports readiness overrides for exceptional documented cases. They
  are not the normal recipe and do not make an unverified worker capable.

Patch-mode readiness and no-write checks trim surrounding mode whitespace,
matching the worker handler; padding `github-propose-patch` does not bypass
either boundary.

### Time budgets and overrides

Current implementation defaults introduced by [PR #2158](https://github.com/jinwon-int/a2a-nexus/pull/2158):
model execution **90 minutes**, runner task/container **100 minutes**, outer
worker handler **120 minutes**. These are ceilings, not expected task durations.

The handler resolves runner task time as
`A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS` → `payload.timeoutMs` → source default.
Changing only the manifest may therefore have no effect on a configured worker.
Other runner/model overrides are documented in the
[runner environment example](../packages/docker-runner/.env.example) and
[broker environment example](../packages/broker/.env.example); the actual handler
mapping is in [a2a-task-handler.mjs](../packages/broker/scripts/a2a-task-handler.mjs).
Analysis bridges and deterministic/fanout profiles have their own settings.
Do not apply implementation budgets to all analysis paths by assumption.

When observing a broker shutdown, the reported duration includes the pre-close
drain and persistence cleanup from the first termination signal. Repeated
SIGINT/SIGTERM signals are ignored while graceful shutdown is in progress. A
failed persistence close produces a failure log and nonzero exit; do not treat
it as a completed drain or proof of safe fence release. See
[shutdown timing](../packages/broker/README.md#shutdown-timing).

## 4. Dispatch, read back and recover

Only after the task's live effects are authorized and the environment has
injected `A2A_EDGE_SECRET` into this process without exposing its value:

```bash
node scripts/a2a-dispatch-round.mjs --manifest round.json --worker-readiness readiness.json --verify --json
```

Keep manifests and result files in private state with owner-only permissions;
redact before publishing evidence. Never put credentials into the manifest,
command-line arguments, a PR or a pasted shell transcript.

`--verify` reads tasks after submission; **it does not wait for completion**.
Persist the exact task IDs and poll `GET /tasks/:id` with the same edge-secret,
requester-id and requester-role headers described in the
[broker request contract](a2ad-round-dispatch.md#broker-request-contract).
Observe the `status` field; heartbeat timestamps alone are not progress.
Retain a checkpoint or the environment's supported durable wait before ending
a session that promises to resume. Do not invent a Nexus wait CLI.

| Result or symptom | Next action |
| --- | --- |
| `accepted-unconfirmed`, transport timeout, ambiguous create response | Read the exact task ID before retrying. Do not mint a new ID merely to get a clean response. |
| `already-exists` | Resume the existing task; compare its intended work with the manifest. |
| `preflight-excluded` | No task was created for that lane. Resolve readiness or report the exclusion. |
| `spec_underspecified` | Fix the missing contract fields before another dispatch. |
| `handler_exit_nonzero` | Inspect the structured underlying provider/runner error; the wrapper code alone is not a root cause. |
| Authentication error with turns/time remaining | Report authentication failure; increasing time limits is not a fix. |
| Task failed but a PR or patch exists | Preserve the failed task record; recover and independently validate the artifact as a separate finalizer outcome. |
| Projection failure or empty analysis | Verify source carriers and projection evidence; use [offline replay](operators.md#round-replay-before-live-re-dispatch-1302) before spending another live round. |

Serving-fence recovery uses stricter fail-closed occupancy checks: ambiguous
`lsof`/`ps` output aborts before any fence, backup or audit mutation. Bare and
path-qualified `node dist/server.js` invocations count as a running broker.
See [broker recovery checks](../packages/broker/README.md#serving-fence-recovery-checks)
for accepted probe shapes and the requirement to keep the broker stopped.

With the default-off `BROKER_SHARED_STATE_V1_GRAPH` flag enabled, every task
terminal transition appends one immutable source fact through the V1 graph
authority, and a terminal transition fails whole with retryable
`state_unavailable` when that authority is unavailable — never a local
fallback. Since the #1504 cold-start resync change, a cold or raced gate
resolves a stale sequence expectation with one durable high-water read plus a
bounded compare-and-set retry (8-round budget). Rejected append attempts no
longer grow with the sequence gap; the SQLite read still scans the namespace
rows, so this is not a constant-time query or a measured fleet-latency claim. A
`source_high_water_below_tracked_expectation` failure means the durable
source ledger regressed below what the gate already observed — investigate
the store (rollback, corruption, wrong file); do not simply retry. The flag
remains default-off; this behavior change authorizes no deployment or
activation.

Terminal failure is not permission to replay side effects. Inspect retry lineage
and existing artifacts before creating a corrected follow-up task.

## 5. Finalize from evidence

For every lane record task ID, terminal status, substantive result or failure
class, artifact/PR reference and remaining work. Host smoke or a generic ACK is
not repository correctness or review consensus. For A2AD consensus reporting,
consult `node scripts/a2ad-finalizer-gate.mjs --help` and the
[finalizer guide](operators.md); this gate does not publish or merge anything.

Compare the changed paths with declared scope. Review the current full PR head,
run relevant tests and require green CI and independent review under the target
repository's current protection policy. On a merge queue, admission is not
merge: read back `MERGED` and the merge commit. Remove automatic `Closes` text
when a PR implements only a slice of its parent issue. Track runtime rollout,
observation windows and remaining acceptance criteria separately.

For per-worker latency and receipt measurements, hub/operator requesters can
read the advisory `GET /stats/workers` view
(`a2a.worker-latency-profiles.v1`, consumption contract in
[worker latency advisory](worker-latency-advisory.md)). Its receipt counters
(source bytes, model requests, schema retries, requested/actual model coverage)
are body-free aggregates: missing, invalid and truncated telemetry stay
distinct. Count totals above safe-integer range are `null`, never rounded
counts or zero; model comparisons are literal identifier equality only
(alias-equivalent ids count as differences). It is tie-break/advisory data —
never routing authority, success evidence, or an #1815 A/B attestation.

The read-only `a2a.peer.status` RPC is advisory telemetry as well: since #2065
it computes a common 90 s staleness window and a fixed 10-slot advisory busy
budget (`active + queued`) for every `workerMode`. The common
`workerOfflineAfterMs` overrides the default; a supplied legacy
`mobileOfflineAfterMs` takes precedence for declared mobile workers only.
Resolution uses `??`, preserving explicit zero and longer windows. The
`/dashboard` and `/workers/capacity` projections use the same common
`workerOfflineAfterMs ?? 90 s` window as raw `GET /workers` and
`GET /workers/:id`, and none of these surfaces synthesize the retired
`mobileHealth` field any more. See the
[peer-status reference](../packages/broker/docs/phase-8-peer-status-rfc.md#25-worker-modes-and-capacity-revised-by-2065).

Conversation-recipient liveness (`GET /conversations/:id/delivery`) has always
applied one universal ladder for every `workerMode` (≤30 s online, ≤90 s stale,
then offline). It now names that ladder with the neutral
`HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS` / `HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS`
constants; the legacy `MOBILE_OFFLINE_AFTER_MS` / `MOBILE_DISCONNECTED_AFTER_MS`
names remain deprecated exact-value aliases (30,000 / 90,000) so existing
imports are unchanged. These constants describe only the existing
conversation/legacy-health ladder — they are not defaults for raw `GET /workers`
or `a2a.peer.status`, which keep the common 90 s window described above.

The same `GET /stats/tasks` response also carries an advisory
`laneCohorts` section (`a2a.task-lane-shadow-cohorts.v1`, contract in
[fast lane spec](specs/fast-lane.md)): body-free fast/full shadow cohorts
derived only from the broker-owned create-time `laneAssignment`. Legacy
records without an assignment and invalid/unsupported assignments are counted
separately and never coerced into an observed fast cohort; cohort + absent +
invalid always reconciles to the window total. **Every task still runs full
execution**; these cohorts are descriptive shadow data — not causal
speedup/quality evidence and not rollout authorization. #1601 stays open for
execution policy, real canary/performance validation and extraction scope.

## Keeping this manual current

**A usage-changing PR must update this manual and the affected detailed
reference in the same PR.** This includes CLI flags, manifest/API requirements,
authentication handling, defaults/precedence, supported modes, task/readback
semantics and recovery procedures. Internal-only changes can state “no usage
change” with a concrete reason in the PR template.

Reviewers check the actual commands/schema against the implementation. Run the
smallest relevant help, offline dry-run, contract tests and documentation checks;
record what was verified and on which source revision. If a rename is needed,
keep a forwarding entry at this path and update every discovery link.

The [contribution rules](../CONTRIBUTING.md) and
[PR template](../.github/pull_request_template.md) make this a review requirement.
Existing CI checks links and public safety; it does **not** prove semantic
manual freshness. A checked box alone is not evidence that instructions work.
