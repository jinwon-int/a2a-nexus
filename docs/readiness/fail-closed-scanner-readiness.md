# Fail-Closed Scanner and Readiness Gates

> **Current-state note:** This page is a historical fail-closed readiness gate record. Live GitHub still reports `jinwon-int/a2a-nexus` as private unless a separately approved visibility action changes it; the residual gates now apply to promotion/stable-release readiness and public-transition evidence hygiene, not as proof that repository visibility has already changed. Historical NO-GO evidence is preserved intentionally.

This lane defines the Team2/Gwakga handoff for public/private boundary readiness. It is intentionally conservative: missing or ambiguous evidence is a **NO-GO**, not a warning.

Scope: `jinwon-int/a2a-plane#136`, parent `#130`, run `a2a-plane-post78261-next-20260509T142546Z`.

## Readiness rule

The aggregate public-readiness decision is **GO** only when every required gate in [`fail-closed-gates.json`](./fail-closed-gates.json) is explicitly GO with redacted evidence. If any required gate is missing, stale, disputed, or unavailable, the aggregate decision is **NO-GO / Waiting**.

Required gates:

1. **Public/private boundary** — the repository remains private until an explicit visibility decision is recorded. Public docs and examples must not expose private endpoints, provider IDs, Telegram IDs, host-specific paths, raw session dumps, or OpenClaw runtime/bootstrap context.
2. **Terminal evidence** — linked, redacted terminal requester/operator-visible evidence must prove the candidate flow reached terminal receipt. Provider message IDs, accepted-send results, queued states, or delivery attempts are not terminal ACK evidence.
3. **Replay-safety proof** — linked, redacted replay/canary evidence must show duplicate sends or retries cannot mint a false terminal ACK.
4. **Scanner output evidence** — `npm run scan:external-secrets` or an equivalent supported external scanner must run in the operator environment. If no supported scanner is installed, the lane must post Block evidence and remain NO-GO.
5. **Runtime/bootstrap hygiene** — `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**` must not enter the branch diff, artifacts, issue comments, or PR body.
6. **GO/NO-GO matrix** — every required gate needs a status, owner, timestamp, and redacted evidence link. The matrix must not collapse partial readiness into GO.
7. **Redacted evidence policy** — evidence may include commands, exit statuses, counts/classes, commit SHAs, and links. It must not include matched secret values, raw private paths, raw session dumps, or provider-specific identifiers.
8. **Explicit operator approval** — public repository visibility requires a separate operator comment that explicitly names repository visibility/publication. It must not be inferred from passing tests, merged PRs, or general approval of docs.

## Scanner/readiness script

Use the machine-readable gate validator before posting PR/Done evidence:

```sh
npm run scan:readiness-gates
```

The validator checks that the gate spec itself is fail-closed and that every gate needed for a GO decision is explicitly represented. It does not replace the external secret/history scanner; it only prevents accidental weakening of the gate definitions.

For a candidate evidence packet, run:

```sh
node scanner/readiness/fail-closed-gates.mjs --spec docs/readiness/fail-closed-gates.json --input <redacted-evidence.json>
```

The input packet is intentionally simple:

```json
{
  "decision": "GO",
  "gates": {
    "publicPrivateBoundary": { "status": "GO", "evidence": ["issue or PR URL"] },
    "terminalEvidence": { "status": "GO", "evidence": ["redacted terminal evidence URL"] },
    "replaySafety": { "status": "GO", "evidence": ["redacted replay-safety URL"] },
    "externalScannerEvidence": { "status": "GO", "evidence": ["redacted scanner URL"] },
    "runtimeBootstrapHygiene": { "status": "GO", "evidence": ["diff check URL"] },
    "goNoGoMatrix": { "status": "GO", "evidence": ["matrix URL"] },
    "redactedEvidencePolicy": { "status": "GO", "evidence": ["evidence policy URL"] },
    "operatorApproval": { "status": "GO", "evidence": ["operator approval URL"] }
  }
}
```

If `decision` is `GO`, the script exits non-zero unless every required gate has `status: "GO"` and at least one redacted evidence link. It also fails closed when evidence entries contain obvious unredacted material such as token-shaped strings, secret assignments, host-specific private paths, or raw session-dump markers.

Operator approval is validated as its own final gate: `operatorApproval.evidence` must be present and must not reuse the same evidence link as scanner, terminal, replay, matrix, hygiene, or policy gates. Passing scanner/readiness checks never substitutes for explicit repository visibility/publication approval.

For `NO-GO`, `WAITING`, or `BLOCK`, the script exits zero after reporting the blockers; those states are valid fail-closed outcomes.

## Safe evidence template

Use this shape in issue/PR evidence:

```md
Decision: NO-GO / Waiting

Commands:
- npm run scan:readiness-gates — pass
- npm run scan:public-readiness — pass/fail with finding count only
- npm run scan:external-secrets — pass, or blocked because no supported scanner is installed

Terminal/replay gates:
- Terminal evidence and replay-safety proof are linked as redacted evidence, or the decision remains NO-GO / Waiting.

Runtime/bootstrap hygiene:
- Branch/artifacts exclude AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, IDENTITY.md, and .openclaw/**.

Operator approval:
- Not present unless linked to an explicit repository visibility/publication approval.
```

Never paste raw secret values, private host paths, raw OpenClaw session context, provider IDs, Telegram IDs, or terminal ACK records into evidence.
