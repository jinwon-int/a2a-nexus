# Contract conformance fixtures

These public-safe fixtures exercise the A2A Plane contracts without depending on a live broker, worker, provider, database, or terminal outbox. They are intended for cross-team compatibility tests and should remain independent from `examples/local/**` quickstart implementations.

Fixture set:

- `task-lifecycle.json` — lifecycle states, allowed transitions, and a complete PR-path event trace.
- `worker-registration-capabilities.json` — worker registration and capability read-model assumptions.
- `cancellation-idempotency.json` — duplicate request, cancellation, and terminal replay behavior.
- `terminal-evidence.json` — redacted PR, Done, and Block terminal evidence examples.
- `gwakga-cross-broker-handoff.json` — synthetic Seoseo-to-Gwakga handoff proof for the Team2 lane; it records Gwakga as broker of record, shows that Seoseo does not directly dispatch Team2 workers, lists no-live validation commands, and calls out visibility gaps around accepted-send/non-ACK evidence.
- `parent-terminal-brief-aggregation.json` — synthetic Gwakga-origin plus Seoseo-handoff canary proof for parent broker Terminal Brief aggregation; it covers parent round metadata lifecycle, required projection fields, redaction, rollback, and no-replay behavior.
- `terminal-brief-parent-origin-routing.json` — four-case Terminal Brief routing matrix for Seoseo/Team1 and Gwakga/Team2 parent-origin ownership.
- `public-compatibility-policy.json` — issue #94/#166 policy proof that public compatibility claims are validated from contracts, synthetic fixtures, and the compatibility matrix rather than private Seoseo-only assumptions.
- `second-worker-replay-trace.json` — public-safe second-reference-worker replay proof showing a replay returns existing terminal evidence with zero duplicate sends, zero duplicate ACKs, and compact redacted trace fields.
- `a2a-spec-first-taskflow-bridge.json` — design fixture for mapping a spec-first A2A packet into managed TaskFlow state without enabling runtime automation.
- `a2a-spec-first-taskflow-runtime-dryrun.json` — dry-run runtime rehearsal packet that validates the managed flow draft without creating live TaskFlow jobs.
- `adapter-receipt-capability.json` — six-level adapter receipt capability contract fixture (C1–C6) for non-OpenClaw/Hermes/spool Terminal Brief adapters, mapping adapter states to the four frozen receipt levels and enforcing the produced/spooled/provider-only non-ACK boundary.

Do not add secrets, host-specific paths, OpenClaw runtime/bootstrap files, raw session dumps, live provider payloads, or terminal ACK mutation records to these fixtures.
