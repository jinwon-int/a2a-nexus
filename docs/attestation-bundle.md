# Attestation bundle format v0 (#1301 M3)

One JSON document per task that answers "can you audit what the agent did"
without chasing evidence across PR bodies, task records, and round manifests.
The exporter assembles it from the broker's stored task record; the checker
verifies it with **no broker access**, so the party receiving a bundle can
validate it independently.

- Exporter: `packages/broker/scripts/export-attestation-bundle.mjs`
- Checker (consumer side): `scripts/check-attestation-bundle.mjs`

## Document shape

```json
{
  "bundleVersion": "0",
  "subject": {
    "kind": "task",
    "taskId": "round-77-<author>-01",
    "taskIdHash": "sha256:<64 hex of the raw task id>",
    "intent": "analyze",
    "status": "failed",
    "completedAt": "2026-07-07T00:00:00.000Z"
  },
  "contract": {
    "acceptance": { "kind": "command", "command": "npm test" },
    "declaredScope": { "paths": ["src/x.ts"] },
    "evidenceGate": "missing"
  },
  "evidence": {
    "redGreen": "missing",
    "validations": [
      { "kind": "smoke", "verdict": "pass", "role": "author" },
      { "kind": "review", "verdict": "pass", "role": "reviewer", "note": "…" }
    ],
    "failures": [
      { "code": "handler_exit_nonzero", "stage": "handler", "excerpt": "…redacted, bounded…" }
    ],
    "provenance": { "resultHash": "sha256:…", "workerSigned": true, "brokerCountersigned": true }
  },
  "integrity": { "alg": "sha256-jcs", "hash": "<64 hex>" }
}
```

## Rules

1. **Missing ≠ empty.** A field the exporter cannot collect is the literal
   string `"missing"` — an audit document must distinguish "there was nothing"
   from "we don't know". `evidence.redGreen` is `"missing"` in v0 because the
   broker store does not retain PR-body red/green logs; merging repo-side
   evidence into the bundle is a documented follow-up, not a silent gap.
2. **Roles, never names.** Validation entries carry `role`
   (`author` | `reviewer` | `unknown`), derived by comparing the validator's
   node id against the task's producer. Node ids themselves never appear —
   a bundle whose validation carries a `nodeId` key fails the checker.
3. **Redaction (exporter side).** Every string leaf rides the existing broker
   redaction path (`task-error-details` `redactAndBoundFailureExcerpt`:
   secrets, tokens, contact handles, private paths, line/char bounds — no new
   redaction logic), and every internal node identifier reachable from the
   task record (claim/assignment/target/requester ids, validation node ids,
   plus `--scrub-ids` extras) is replaced with its role token in every string,
   including the display `taskId`. Correlation back to the real task uses
   `subject.taskIdHash` (sha256 of the raw id).
4. **Provenance is distilled**, not copied: signature key ids embed node
   names, so the bundle records `resultHash` plus worker/broker signature
   presence. Full cryptographic verification stays with the provenance report
   path (`contracts/a2a/verifiable-analysis-report.md`) — the bundle points at
   the same `resultHash` so the two documents cross-reference.
5. **Integrity.** `integrity.hash` = SHA-256 over the RFC 8785 (JCS)
   canonicalization of the bundle **without** its `integrity` field
   (`alg: "sha256-jcs"`, same canonicalization path as the offline verifiers
   in `scripts/lib/a2a-offline-verify.mjs`). Any post-export edit is detected
   by recomputation; pretty-printing round-trips safely because the canonical
   form is whitespace- and key-order-independent.
6. **Checker is the second line of defense.** Beyond schema and integrity, it
   scans every string leaf with the same fail-closed identifier/secret gate
   used by the reliability ledger and injected-knowledge snapshots (URLs,
   `worker-`/`node-` shapes, host words, token shapes). A bundle that fails
   the scan must not be shipped — regenerate with `--scrub-ids` or fix the
   upstream record; do not hand-edit (that breaks integrity by design).

## Usage

```
# single task record (the JSON the broker returns/stores for a task)
node packages/broker/scripts/export-attestation-bundle.mjs --task-file task.json --out bundle.json

# from a read-only sqlite snapshot (npm run export:sqlite)
# NOTE: on a broker running BROKER_SQLITE_LOAD_SOURCE=hot-tables, pass
# --load-source hot-tables to export:sqlite — the canonical snapshot blob
# goes stale in that mode and would silently export old state
node packages/broker/scripts/export-attestation-bundle.mjs --state-json state.json --task <id> --out bundle.json

# one bundle per lane of a round
node packages/broker/scripts/export-attestation-bundle.mjs --state-json state.json --round <parentRoundId> --out-dir bundles/

# consumer-side verification (no broker access)
node scripts/check-attestation-bundle.mjs bundle.json
```

The exporter requires the broker package to be built (`npm run build` in
`packages/broker`) because the redaction path is imported from `dist/`.

## Out of scope for v0 (appendix)

- **Signing the bundle** (operator key management) — the integrity hash
  detects tampering but does not prove issuer; a signed variant would reuse
  the JCS/JWS path from `scripts/lib/a2a-offline-verify.mjs`. Separate,
  approval-gated issue.
- **Publishing/uploading bundles** — the exporter writes local files only;
  distribution is an operator action.
- **PR-subject bundles** (`subject.kind: "pr"`) and repo-side red/green log
  merging — follow-ups once the task-subject bundle has real audit mileage.
