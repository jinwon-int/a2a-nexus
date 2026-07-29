# Contract conformance fixtures

These public-safe fixtures exercise the A2A Nexus contracts without depending on a live broker, worker, provider, database, or terminal outbox. They are intended for cross-team compatibility tests and should remain independent from `examples/local/**` quickstart implementations.

Fixture set:

- `task-lifecycle.json` — lifecycle states, allowed transitions, and a complete PR-path event trace.
- `worker-registration-capabilities.json` — worker registration and capability read-model assumptions.
- `cancellation-idempotency.json` — duplicate request, cancellation, and terminal replay behavior.
- `terminal-evidence.json` — redacted PR, Done, and Block terminal evidence examples.
- `broker-beta-cross-broker-handoff.json` — synthetic broker-alpha-to-broker-beta handoff proof for the Team2 lane; it records broker-beta as broker of record, shows that broker-alpha does not directly dispatch Team2 workers, lists no-live validation commands, and calls out visibility gaps around accepted-send/non-ACK evidence.
- `parent-terminal-brief-aggregation.json` — synthetic broker-beta-origin plus broker-alpha-handoff canary proof for parent broker Terminal Brief aggregation; it covers parent round metadata lifecycle, required projection fields, redaction, rollback, and no-replay behavior.
- `terminal-brief-parent-origin-routing.json` — four-case Terminal Brief routing matrix for broker-alpha/Team1 and broker-beta/Team2 parent-origin ownership.
- `public-compatibility-policy.json` — issue #94/#166 policy proof that public compatibility claims are validated from contracts, synthetic fixtures, and the compatibility matrix rather than private broker-alpha-only assumptions.
- `second-worker-replay-trace.json` — public-safe second-reference-worker replay proof showing a replay returns existing terminal evidence with zero duplicate sends, zero duplicate ACKs, and compact redacted trace fields.
- `a2a-spec-first-taskflow-bridge.json` — design fixture for mapping a spec-first A2A packet into managed TaskFlow state without enabling runtime automation.
- `a2a-spec-first-taskflow-runtime-dryrun.json` — dry-run runtime rehearsal packet that validates the managed flow draft without creating live TaskFlow jobs.
- `adapter-receipt-capability.json` — six-level adapter receipt capability contract fixture (C1–C6) for non-OpenClaw/Hermes/spool Terminal Brief adapters, mapping adapter states to the four frozen receipt levels and enforcing the produced/spooled/provider-only non-ACK boundary.
- `bounded-pr-review-lifecycle.json` — bounded PR review lifecycle lineage (#1518 Phase 1): frozen IntentContractV1 with canonical intentHash, global ReviewLineageBudgetV1, FindingLedgerV1 with stable finding dispositions, and an extended ReviewReceiptV1 bound to headSha/diffHash/intentHash plus a dispatcher-declared trusted author.
- `task-attempt-failure-sharing.json` — source-only P2-B golden vectors for closed public-safe broker execution outcomes and explicit bounded-experiment dispositions, deterministic identity/fingerprint framing, replay/conflict behavior, and non-authoritative failure-history projections.

Do not add secrets, host-specific paths, OpenClaw runtime/bootstrap files, raw session dumps, live provider payloads, or terminal ACK mutation records to these fixtures.
