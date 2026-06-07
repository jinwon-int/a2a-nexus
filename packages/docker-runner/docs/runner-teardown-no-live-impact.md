# Runner teardown & no-live-impact guidance

Scope: operator guidance for safe teardown, cleanup, and no-live-impact verification
of the a2a-docker-runner. All steps are deterministic, CI-safe, and require no
live provider sends, Gateway/broker/worker restarts, DB mutations, Terminal ACKs,
or production service changes.

## Principles

1. **No-live by default** — All built-in templates (`terminal-brief-*`) enforce
   `A2A_DOCKER_RUNNER_NO_LIVE=1` in their env. Never send provider messages,
   restart services, mutate DBs, or ACK Terminal Briefs from automated tasks.

2. **Read-only audit** — The scanner's `readinessScan`, `buildCleanupDryRunPlan`,
   and `createArtifactBundle` are read-only by construction. They never mutate
   disk state, prune directories, or write back to the runner store.

3. **Deterministic output** — All scanner profiles, readiness reports, cleanup
   plans, and artifact bundles use the fixed timestamp `1970-01-01T00:00:00.000Z`
   and deterministic sorting, making outputs reproducible for identical inputs.

4. **Fail-closed redaction** — Every output path redacts secrets, strips null
   bytes, bounds field sizes, and filters unsafe URLs before any data leaves
   the runner.

## Codebase patterns for no-live safety

### Readiness scan (src/scanner.ts)

```typescript
import { readinessScan } from "@openclaw/a2a-docker-runner/scanner";

const report = await readinessScan({
  rootDir: "/var/lib/openclaw-a2a/tasks",
  staleThresholdMs: 7 * 24 * 60 * 60 * 1000,
});
```

The readiness scan:
- Walks the task root directory (read-only).
- Classifies runs as `ok`, `stale`, `malformed`, or `orphan`.
- Never prunes, moves, or modifies any file.
- Produces a deterministic report with hard-false safety markers.

### Cleanup dry-run plan (src/scanner.ts)

```typescript
import { buildCleanupDryRunPlan } from "@openclaw/a2a-docker-runner/scanner";

const plan = buildCleanupDryRunPlan(report);
// plan.safety.mutationPerformed === false
// plan.safety.operatorApprovalRequired === true
// plan.safety.backupRequired === true
```

The cleanup dry-run plan:
- Is a pure data transformation — never touches the filesystem.
- Assigns risk classes: `low` (orphans), `medium` (stale < 7d), `high` (stale > 7d), `blocked` (ok entries).
- Includes an operator pre-execution checklist and rollback notes.
- Every cleared entry requires operator approval plus verified backup.

### Artifact bundle (src/scanner.ts)

```typescript
import { createArtifactBundle } from "@openclaw/a2a-docker-runner/scanner";

const bundle = await createArtifactBundle({
  workDir: "/var/lib/openclaw-a2a/tasks/my-task/run-001",
  outputPath: "/tmp/redacted-bundle",
});
```

The artifact bundle:
- Copies files from the source run directory (read-only).
- Redacts secrets, truncates at safe bounds.
- Writes to a separate output path; never modifies the source.
- Produces a self-contained manifest suitable for external audit chains.

## Teardown patterns

### Task directory cleanup (operator action)

The runner **does not automatically delete old task directories**. Artifacts are
designed as an audit trail. Real cleanup requires operator action:

1. Run a readiness scan to identify stale/malformed/orphan entries.
2. Build a cleanup dry-run plan and review risk classifications.
3. Manually review HIGH-risk entries.
4. Take and verify a backup of the runner rootDir.
5. Obtain explicit operator approval.
6. Execute cleanup against the identified directories.

```bash
# Example: archive stale runs older than 7 days before pruning
find /var/lib/openclaw-a2a/tasks -maxdepth 1 -type d -mtime +7 -exec tar czf /backup/runner-archive-$(date +%Y%m%d).tar.gz {} +
```

### No-live verification bundle

Use the scanner to produce a redacted evidence bundle that can be shared with
auditors or operators without exposing host paths, secrets, or live service
details:

```bash
node -e "
const { createArtifactBundle } = require('./dist/scanner.js');
createArtifactBundle({
  workDir: '/var/lib/openclaw-a2a/tasks/my-task/20250101T000000Z-abc',
  outputPath: '/tmp/audit-bundle',
}).then(m => console.log('Bundle created:', m.artifacts.length, 'files'));
"
```

The bundle manifest never contains:
- Host-specific absolute paths.
- Raw GitHub tokens (`ghp_*`, `github_pat_*`).
- API keys (`sk-*`, `xai-*`, `sm_*`).
- Credential key=value pairs.
- x-access-token URLs.

## External scanner evidence placeholders

The `externalScannerEvidence` field on `ArtifactManifest` and `ScanRunEntry` provides
a contract for accepting SAST, DAST, CVE, SBOM, and dependency audit results into
the evidence chain without the runner performing the scans itself.

Example: Including Trivy CVE scan results as external scanner evidence:

```typescript
const manifest: ArtifactManifest = {
  // ... standard fields ...
  externalScannerEvidence: [{
    schemaVersion: "a2a.runner.external-scanner-evidence.v1",
    tool: "cve_scan",
    toolName: "Trivy",
    toolVersion: "0.58.0",
    scannedAt: "2025-06-01T00:00:00.000Z",
    summary: { total: 3, critical: 0, high: 1, medium: 2, low: 0, info: 0 },
    findings: [
      { id: "CVE-2025-1234", severity: "high", title: "Vulnerability in libfoo", cveId: "CVE-2025-1234" },
    ],
  }],
};
```

The scanner's `scanHistory` and `createArtifactBundle` propagate these entries
deterministically, capped at 10 entries per run.

## No-live safety checklist

Before any operation that touches runner state:

- [ ] Run `readinessScan` to understand current state (read-only).
- [ ] Review stale/malformed/orphan classifications.
- [ ] If cleanup is needed, run `buildCleanupDryRunPlan` and review entries.
- [ ] Verify backup exists before any mutation.
- [ ] Obtain explicit operator approval token.
- [ ] Do not run against production rootDir during automated tasks.
- [ ] Do not use `rm -rf` without prior backup verification.
- [ ] Do not prune runs that may still be referenced by a home broker.
- [ ] Do not modify artifact files in-place; prefer the bundle workflow.

## Related

- [Scanner module](../src/scanner.ts)
- [Artifact manifest contract](artifact-manifest.md)
- [Redacted artifact proof example](../examples/runner-redacted-log-proof.json)
- [Release rollout checklist](release-rollout-checklist.md)
