# A2A Nexus Source-Public Dry-Run Tooling

Team1/bangtong lane: implements the source-public dry-run schema and aggregator/report command for deterministic GO/NO-GO evaluation.

**Run:** `a2a-source-dryrun-orchestrator-20260510T133022Z`
**Issue:** #198 (a2a-plane#198, internal tracker private)
**Parent:** #197 (a2a-plane#197, internal tracker private)

## Design

The dry-run tooling consumes evidence packet metadata from three domains — broker, plugin, and runner — and evaluates each gate deterministically to produce a GO/NO-GO decision.

**Fail-closed by default**: every gate must be explicitly GO with redacted evidence links. If any required gate is MISSING, the aggregate decision is NO-GO.

**Approval separation**: the `operatorApproval` gate must use separate, non-bundled evidence. Source-public execution is NO-GO without explicit operator approval that names source-public execution.

## Schema

[`source-public-dryrun-schema.json`](./source-public-dryrun-schema.json) defines the gate structure:

| Gate | Domain | Description |
|------|--------|-------------|
| `brokerReadiness` | Broker | Health, worker matrix, queue/stale closeout, migration gate |
| `pluginReadiness` | Plugin | Read-only projection, no live delivery configured |
| `runnerReadiness` | Runner | Artifact manifest, scanner profile, runner state |
| `publicPrivateBoundary` | Boundary | Repository remains private before approval |
| `terminalEvidence` | Evidence | Redacted terminal requester/operator-visible evidence |
| `replaySafety` | Evidence | Replay/canary proof that duplicate sends cannot mint false terminal ACK |
| `externalScannerEvidence` | Scanner | External secret/history scanner output |
| `runtimeBootstrapHygiene` | Hygiene | No runtime/bootstrap files in branch/artifacts |
| `goNoGoMatrix` | Matrix | Every required gate has status, owner, evidence, timestamp |
| `redactedEvidencePolicy` | Policy | Evidence is redacted, no raw secrets or session dumps |
| `operatorApproval` | Approval | **Separate** explicit operator approval for source-public execution |

## Usage

### Schema validation only

```sh
node scripts/a2a-source-dryrun-aggregator.mjs --spec docs/dry-run/source-public-dryrun-schema.json
```

Prints the default NO-GO decision and required gates. Source-public execution is NO-GO.

### Evidence packet evaluation (JSON)

```sh
node scripts/a2a-source-dryrun-aggregator.mjs \
  --spec docs/dry-run/source-public-dryrun-schema.json \
  --input fixtures/dry-run/team1-bangtong-dryrun-evidence.json
```

Exits 0 for GO (all gates passed), exits 1 for NO-GO/BLOCK (any gate missing or failing).

### Evidence packet evaluation (Markdown)

```sh
node scripts/a2a-source-dryrun-aggregator.mjs \
  --spec docs/dry-run/source-public-dryrun-schema.json \
  --input fixtures/dry-run/team1-bangtong-dryrun-evidence.json \
  --format markdown
```

Produces a deterministic Markdown report with gate status table and blockers.

### Running tests

```sh
node --test scripts/a2a-source-dryrun-aggregator.test.mjs
```

## Evidence packet format

```json
{
  "decision": "GO",
  "gates": {
    "brokerReadiness": {
      "status": "GO",
      "evidence": ["a2a-plane#198 (internal tracker, private)#gate-broker"],
      "evidencePacket": {
        "health": { "ok": true },
        "expectedWorkers": ["bangtong"],
        "onlineWorkerIds": ["bangtong"],
        "queue": { "queued": 0, "claimed": 0, "running": 0 },
        "stale": 0
      }
    },
    "pluginReadiness": {
      "status": "GO",
      "evidence": ["a2a-plane#198 (internal tracker, private)#gate-plugin"],
      "evidencePacket": {
        "liveTelegramConfigured": false,
        "providerDeliveryEnabled": false,
        "operatorEventsEnabled": false
      }
    },
    "runnerReadiness": {
      "status": "GO",
      "evidence": ["a2a-plane#198 (internal tracker, private)#gate-runner"],
      "evidencePacket": {
        "artifactManifest": { "ok": true },
        "scannerProfile": { "ok": true },
        "productionDeploy": false,
        "providerCalled": false
      }
    },
    "...remaining gates..." : {
      "status": "GO",
      "evidence": ["URL"]
    }
  }
}
```

## Safety gates

This tooling is **read-only**:
- No production deploy/restart
- No Gateway/broker/worker restart
- No live provider/Telegram send
- No terminal ACK
- No production DB mutation
- No secret/visibility change
- No history rewrite or force-push
- No release publication or community post

**Source-public execution remains NO-GO** without explicit operator approval.
