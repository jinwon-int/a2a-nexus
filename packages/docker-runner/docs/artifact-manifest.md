# Artifact manifest contract

The runner writes a stable, public-demo-safe manifest to `artifacts/manifest.json` for every task. Version 1 projects runner output into A2A `Artifact`/`Part` concepts: the manifest is the task `Artifact`, and each item in `evidence` is a renderable `Part` backed by an optional artifact file.

Schema: [`docs/artifact-manifest.schema.json`](artifact-manifest.schema.json)
Sample: [`examples/artifact-manifest.dummy-task.json`](../examples/artifact-manifest.dummy-task.json)

## Required fields

- `artifactVersion`: stable public contract version. Current value: `1`.
- `schemaVersion`: backward-compatible alias for older runner consumers. Current value: `1`.
- `manifestPath`: always `artifacts/manifest.json`.
- `generatedAt`: deterministic generation timestamp; current runner uses `1970-01-01T00:00:00.000Z` so identical artifacts produce stable manifests.
- `status`: one of `done`, `blocked`, `failed`, or `budget_limited`. `budget_limited` is not Done; it means bounded execution stopped and any continuation must be separately approved.
- `summary`: non-empty operator-friendly text for broker/plugin cards.
- `evidence`: array of A2A Part-like evidence entries.
- `artifacts`: file inventory backing the manifest.

## Optional task fields

- `taskId`, `repo`, `branch`, `prUrl`, `issueUrl`.
- `budget`: bounded, redacted budget-stop metadata (`limitKind`, optional `limit`/`used`/`reason`) when `status=budget_limited`.
- `receiptTrace`: optional bounded notification/receipt correlation metadata for broker/plugin receipt-gap reports. It may carry safe identifiers such as `outboxId`, `notificationId`, `dedupeKey`, `channel`, `status`, `evidence`, `receiptId`, `attemptCount`, `staleAfterMs`, and bounded `reason`; it must not contain raw prompts, raw command output, message bodies, tokens, or private host paths.
- `continuation`: optional approval-gated follow-up recommendation; `requiresApproval` must be `true`.
- `evidenceHints`: compact Start plus PR/Done/Block URL hints for broker task-report recovery, including failureCategory values such as `timed_out`, `resource_limited`, `embedded_model_timeout_no_fallback`, or `exit_nonzero` for stability gates.
- `githubCommentProjection`: first-class Terminal Brief extension for GitHub issue/PR comment ledger evidence. It is manifest-bound (`manifestPath`), replay-safe (`dedupeKey`), and explicitly flags `commentIsTerminalAck=false`, `commentIsVisibilityReceipt=false`, and `commentIsOperatorApproval=false`.
- `cleanupRehearsal`: deterministic no-live cleanup backup/checkpoint and rollback rehearsal capsule. It records candidate counts, required checkpoint evidence, rollback/abort paths, fail-closed reasons, and hard false flags for production DB mutation, pruning, migration, deploy/restart, live provider sends, and Terminal Brief ACK.
- `externalScannerEvidence`: optional placeholder array for SAST/DAST/CVE/SBOM/dependency-audit scanner findings. Each entry carries the tool identifier, aggregate finding counts by severity, and a bounded list of findings. The scanner never executes external scans — it only ingests pre-existing evidence.
- `sourcePublicApprovalRehearsal`: deterministic no-live source-public approval packet preview. `buildSourcePublicApprovalRehearsal()` can produce the packet envelope before real source-public execution. It carries GO_CANDIDATE/NO_GO/NEEDS_OPERATOR_APPROVAL output, replay/no-duplicate proof, rollback/abort paths, and hard false live-execution flags for approval, release, visibility changes, provider sends, Terminal Brief ACK, and DB mutation.
- `sourcePublicExecutionPreflight`: final dry-run/simulate execution preflight capsule. `buildSourcePublicExecutionPreflight()` binds an approved source-public packet to the redacted manifest digest and scanner/history digest, emits an explicit operator-gated plan, records rollback/abort steps, and fails closed for non-GO packets, missing scanner/history evidence, or manifest digest mismatch. It never performs approval/release/visibility/provider/deploy/DB/ACK actions.

## Evidence parts

Each `evidence[]` entry has:

- `kind`: `log`, `test`, `diff`, or `file`.
- `label`: short display label.
- `status`: optional `passed`, `failed`, `blocked`, or `unknown`.
- `path`: optional artifact path relative to the task work directory.
- `excerpt`: optional bounded, redacted preview. Consumers should render `summary` first, then evidence labels/excerpts; they should not need to read raw logs to avoid empty-success regressions.

## Receipt trace compatibility

`receiptTrace` is additive and backward-compatible. Older consumers can ignore it; newer broker/plugin closeout reports can use it to correlate runner artifacts with terminal-outbox receipt states when receipts are pending, stale, failed, or confirmed. The status vocabulary intentionally distinguishes provider/send progress (`accepted`, `started`, `produced`, `provider_sent`) from operator-visible or acknowledged receipt evidence (`operator_visible`, `operator_confirmed`, `provider_delivery_receipt`, `receipt_confirmed`). Provider send success alone must not be rendered as a completed receipt.

The runner only copies explicitly supplied receipt trace metadata from `task.receiptTrace` or JSON in `task.env.A2A_RUNNER_RECEIPT_TRACE` / `A2A_RECEIPT_TRACE`, and it bounds/redacts string fields before writing `manifest.json` or `resultSummary`.

GitHub evidence remains fail-closed: `github-propose-patch` tasks still fail when no PR/Done/Block URL is produced. GitHub comments are ledger entries only: they do not prove Terminal Brief ACK, read receipt, visibility proof, or operator approval. Cleanup rehearsal, source-public approval rehearsal, and execution preflight packets are evidence only: they never execute approval/release/visibility/provider/deploy/DB/prune/migration/ACK actions and always require explicit operator approval plus required checkpoint/backup evidence before any real cleanup or source-public action. The artifact manifest is additive evidence for rendering and public demos, not a replacement for canonical GitHub closeout evidence.

## Artifact retention & boundaries

The runner writes all task artifacts under `A2A_DOCKER_RUNNER_ROOT` (default: `/var/lib/openclaw-a2a/tasks`) in the layout `rootDir/<safeTaskId>/<runToken>/`. Each run produces 10-30 KB of artifacts (task JSON, summary, command logs, optional diff files, manifest). The `scanner` module (`src/scanner.ts`) can enumerate runs and produce redacted bundles.

### Retention policy

The runner **does not automatically delete old task directories**. The `rootDir` is designed as an audit trail and closeout reference, not a scratch directory. Operators should implement the desired retention strategy for their deployment using the scanner's built-in readiness analysis and cleanup dry-run planning:

1. **`readinessScan`** — Scans all task runs, classifying each as `ok`, `stale`, `malformed`, or `orphan`. Read-only; never mutates disk.
2. **`buildCleanupDryRunPlan`** — Produces a deterministic, operator-gated plan from a readiness report. Assigns risk classes (`low`/`medium`/`high`/`blocked`) and includes safety markers, a pre-execution checklist, and rollback notes. Never mutates disk.
3. **`createArtifactBundle`** — Creates a self-contained, redacted copy of a single run's artifacts for external audit or archival before deletion.

Real cleanup execution requires:
   - Readiness scan and review
   - Cleanup dry-run plan review
   - Backup verification
   - Operator approval
   - Manual or scripted `rm -rf` on identified directories

Operators should implement the desired retention strategy for their deployment:

1. **Short-lived CI environments** (ephemeral containers, CI runners): The task root is typically cleaned up when the container or CI runner terminates. No explicit policy needed.

2. **Long-lived worker nodes** (production worker VPS): Operators should configure a cron or systemd timer to prune runs older than a threshold. For example, a weekly cleanup retaining 7 days of history:

   ```bash
   find /var/lib/openclaw-a2a/tasks -maxdepth 1 -mindepth 1 -type d -mtime +7 -exec rm -rf {} +
   ```

   Equivalent using the built-in scanner:

   ```js
   import { scanHistory } from "@openclaw/a2a-docker-runner/scanner";
   const profile = await scanHistory({
     rootDir: "/var/lib/openclaw-a2a/tasks",
     minAgeMs: 7 * 24 * 60 * 60 * 1000,
   });
   // Then apply profile.runs to cleanup logic
   ```

3. **Disk usage expectations**: Each task run uses approximately 10-50 KB of artifact metadata (manifest, summary, logs) plus any diff files from the container. Container images and cloned repos live inside the container engine cache (not `rootDir`). Operators should monitor `rootDir` disk usage monthly and prune when appropriate.

### What is retained

| Asset | Location | Size bound | Notes |
|---|---|---|---|
| Task definition | `task.json` | ≤ task size | Redacted version copied to `artifacts/task.json` |
| Run metadata | `run.json` | ~0.5 KB | Token, timestamps, build metadata |
| Structured manifest | `artifacts/manifest.json` | ≤ 50 KB | Main evidence contract |
| Summary | `artifacts/summary.txt` | ≤ 10 KB | Key=value metadata written during container execution |
| Command logs | `artifacts/command-*.log` | ≤ 8 KB each | Redacted command output; each command produces one log file |
| Patch command log | `artifacts/patch-command.log` | ≤ 8 KB | When a patch command script is configured |
| Execution proof | `artifacts/execution-proof.json` | ≤ 5 KB | Deterministic execution proof (EPv2) |

### Cleanup safety

- Never delete or modify `rootDir` entries while the runner holds an active run token for a running or recent task. The scanner's `minAgeMs` filter helps prevent racing with active runs.
- Artifact files are `0o700` restricted and owned by the runner process; any external cleanup must run with equivalent privileges.
- The scanner's `createArtifactBundle` produces a self-contained redacted copy; prefer bundling over direct file access for external audit chains.
