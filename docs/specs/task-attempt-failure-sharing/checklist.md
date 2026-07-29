# Checklist: Task Attempt Failure Sharing V1

Refs #1635.

## Contract

- [x] Version is exact and unknown versions fail closed.
- [x] Objects are closed; there are no extension fields or arbitrary maps.
- [x] Strings, identifiers, ordinals, and entry counts are bounded.
- [x] Producer contract, result field, vocabulary, and digest domains agree.
- [x] Broker records cannot assert `keep`, `discard`, or `crash`.
- [x] Experiment records require explicit experiment and hypothesis identity.
- [x] No semantic identity is inferred from existing broker detail or state.
- [x] Structured reason class/code values are closed and producer-specific.
- [x] Canonical ordering, framing, domains, keys, and fingerprints are pinned.
- [x] Exact replay is idempotent; changed payload under one key conflicts.

## Privacy

- [x] No free-form detail or text-derived digest is permitted.
- [x] No credential, path, URL, precise time, or human/worker/provider/requester
  identity is permitted.
- [x] No caller labels, metadata maps, or extension fields are permitted.
- [x] Fixture content is synthetic, closed, and scanned by the checker.

## Advisory boundaries

- [x] Exchange failure-channel shape is a read-only projection, not a write.
- [x] Preflight returns prior failures with `automaticDeny=false`.
- [x] Neither view supplies retry authority, verdict, success evidence, or
  automatic dispatch policy.
- [x] Missing or rejected data leaves current task execution unchanged.

## Slice boundary

- [x] Contract, fixture, checker, and existing-runner registration only.
- [x] No broker core module or root package script.
- [x] No runtime producer, consumer, route, callsite, schema, migration,
  database, persistence, deployment, service, workflow, config, or live policy.
- [x] No change to current TaskRecord, broker exchange, or task lineage.
- [x] No issue completion or closure claim.
