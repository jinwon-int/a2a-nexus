# Shared-State and HA Contract

> **Status:** proposed spec-first packet with bounded Phase 1
> contract/parser/evaluator source slices. Approval of this packet is required
> before runtime implementation. Nothing in this packet claims that a shared
> backend, HA mode, adapter implementation, conformance harness, migration, or
> rollout exists.
>
> **Reference:** Refs #1504.

## 1. Normative language and status

`MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are normative
requirements for a later implementation. Text labeled **Current** describes
the repository at `f6e7bdb5a7e05591dd7b56621ae60b81c2048087`. Text labeled
**Planned** or **Future** is not implemented and must not be advertised as a
runtime capability.

The completed Phase 1 slices define closed source contracts and deterministic
parser/evaluator tables only. They do not:

- implement `SharedStateStorageAdapterV1`;
- change startup, health, readiness, persistence, or request handling;
- add or run adapter conformance tests;
- migrate a database, provision a backend, deploy/restart a broker, or move
  traffic;
- replay, acknowledge, or prune an outbox; or
- authorize a provider send, release, tag, GitHub setting change, merge, or
  issue close.

## 2. Problem and goals

The current broker is safe only inside an explicitly bounded topology. Replay
nonces and rate-limit counters are held in process memory. SQLite provides a
durable single-file broker store and an optional single FIFO writer thread,
but it does not turn independently running broker processes into one
linearizable service. Task claims, idempotency outcomes, and terminal-outbox
ordering therefore cannot be assumed to compose across processes.

This contract has five goals:

1. give every deployment an exact, honest grade;
2. define the state and failure semantics of every shared-state primitive;
3. define one versioned adapter contract that a later SQLite single-writer
   adapter and a later shared backend can both satisfy;
4. make an unsupported topology non-serving rather than silently unsafe; and
5. fold the #1504 claim-graph scenario into the same source-of-truth,
   projection, rollback, and observability rules.

## 3. Deployment-grade catalog

The grade name describes the topology and minimum supported behavior. The
per-primitive sections remain authoritative; a durable business-state backend
does not imply durable replay or rate-limit state.

| Exact grade | Current support | Topology and minimum contract |
| --- | --- | --- |
| `single-process` | Supported alpha posture | Exactly one broker process owns all mutable state. JSON-file, SQLite, and process-local state MAY be used. Replay/rate-limit state is volatile and restart reset risk MUST be exposed. This grade is not HA or multi-tenant isolation. |
| `single-writer-durable` | Supported alpha posture for durable broker lifecycle state | Exactly one serving broker process and one logical SQLite writer. SQLite WAL and the optional FIFO writer thread remain single-writer mechanisms, not clustering. Current replay/rate-limit state is still process-local; the grade MUST NOT be described as durable security continuity until a conforming adapter exists. |
| `multi-process-unsupported` | Explicitly unsupported and non-serving | Requested or detected concurrent broker processes without a conforming shared adapter. Startup MUST fail before accepting traffic where possible. If detected after listen, readiness MUST fail and all non-liveness routes MUST return a retryable unavailable response. |
| `shared-state-ha` | **Future; unavailable** | Multiple serving processes using a backend that has passed every `SharedStateStorageAdapterV1` conformance and failure test, topology fencing, migration gate, and separate operational approval. No such backend is present in this repository. Configuration MUST fail closed until one exists and is approved. |

The planned configuration vocabulary is
`BROKER_DEPLOYMENT_GRADE=single-process|single-writer-durable|shared-state-ha`.
`multi-process-unsupported` is an effective health/readiness grade, not a
configuration that enables service. The exact configuration surface is
planned work and does not exist in this phase.

### 3.1 Grade invariants

- A process MUST advertise exactly one configured grade and exactly one
  effective grade.
- An omitted grade MAY default to `single-process` for backward compatibility,
  but health MUST report `gradeDefaulted=true`.
- `single-process` and `single-writer-durable` MUST acquire exclusive serving
  ownership. A live ownership conflict changes the effective grade to
  `multi-process-unsupported`.
- An expected replica/process count greater than one MUST NOT start under
  either single-process grade.
- SQLite file locking or WAL support alone MUST NOT be treated as broker
  ownership or distributed claim fencing.
- `shared-state-ha` MUST NOT be advertised merely because a network database
  can be reached. The adapter version, required capabilities, topology fence,
  conformance evidence, migration state, and operator cutover approval must
  all be present.

## 4. Cross-cutting state rules

### 4.1 Keys, identities, and privacy

Storage keys MUST be namespace-scoped and collision-resistant. Security and
health projections MUST use digests or opaque internal keys at rest and MUST
NOT expose raw nonces, credentials, requester/worker identities, IP
addresses, lease owners, task payloads, provider IDs, database paths/DSNs, or
graph content.

Digesting an identity makes it pseudonymous, not public-safe. Health and
readiness MUST expose only bounded aggregates and enumerated reason codes, not
digests or top-key lists.

#### 4.1.1 Keyspace V1 canonical bytes

Every digest-bearing field in the section 6.1 operations uses exactly
`a2a.shared-state.keyspace/v1`. The machine-readable registry is
`SHARED_STATE_STORAGE_V1_VALUES.digestDomains`; the public golden vectors are
`packages/broker/fixtures/shared-state-storage/keyspace-v1-golden.json`.
Neither artifact authorizes a storage or runtime callsite.

The closed canonicalization input is
`{keyspaceVersion, domain, namespace, components}`:

- `keyspaceVersion` MUST equal `a2a.shared-state.keyspace/v1`.
- `domain` MUST be one registered ASCII purpose token. Domain tokens are at
  most 96 bytes and are not caller-extensible in V1.
- `namespace` MUST match
  `[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*`, MUST be non-empty, and MUST be at most
  96 ASCII/UTF-8 bytes. Case folding and Unicode normalization are forbidden
  for namespaces; a non-canonical namespace is rejected.
- `components` MUST contain the exact registered field names, types, count,
  and order for the domain. A V1 domain has at most eight components. Field
  names are exact, case-sensitive ASCII registry values.
- An `utf8` value MUST be a Unicode scalar-value sequence. Lone UTF-16
  surrogates are invalid. Both the input and normalized value MUST be from 1
  through 1024 UTF-8 bytes. The canonical value is Unicode Normalization Form
  C (NFC) encoded as UTF-8. No trimming, case folding, locale transform, or
  delimiter escaping occurs.
- A `bytes` value MUST be a non-empty, even-length hexadecimal string
  representing at most 1024 octets. Upper- or lowercase input is accepted;
  the normalized machine value is lowercase hex and the canonical value is
  the represented octets. Odd-length, non-hex, and implicit text-to-byte
  conversions are invalid.
- A `uint` value MUST be either a non-negative JavaScript safe integer or a
  canonical decimal string matching `0|[1-9][0-9]*`. Negative, fractional,
  exponential, signed, padded, and unsafe numeric inputs are invalid. Its
  range is `0` through `2^128-1`; the canonical value is exactly 16-byte
  unsigned big-endian. A safe numeric value and its canonical decimal string
  therefore produce identical bytes.

The complete byte grammar is below. `u16be` and `u32be` are unsigned
big-endian integers. `short(x)` is `u16be(byteLength(x)) || x`.
`component-value` is the canonical value described above.

```text
canonical-key-v1 =
  hex("4132412d53534b")                   ; ASCII "A2A-SSK"
  || hex("01")                              ; framing version
  || short(ASCII("a2a.shared-state.keyspace/v1"))
  || short(ASCII(domain))
  || short(ASCII(namespace))
  || u16be(component-count)
  || component[0] || ... || component[n-1]

component =
  short(ASCII(field-name))
  || type-tag                                ; utf8=01, uint=02, bytes=03
  || u32be(byteLength(component-value))
  || component-value
```

Length prefixes, explicit type tags, and registered ordering are normative.
Concatenation with separators, JSON serialization, platform-native integer
width or endianness, and object-property iteration order MUST NOT be used as
substitutes.

#### 4.1.2 Digest purposes and tokens

The digest is SHA-256 over `canonical-key-v1`. Its external token is exactly:

```text
a2a.shared-state.keyspace/v1 "|" domain "|" namespace "|" "sha256:" 64-lowercase-hex
```

The separator cannot occur in version, domain, or namespace tokens; raw
component values never participate in this display syntax. Every field parser
MUST validate the token's version and registered domain. Command parsers also
MUST match the token namespace to the command's input namespace; a result
consumer MUST make the same comparison when binding a committed result back
to its originating command. The version and domain are also inside the
hashed, length-framed preimage. A digest token for another version, namespace,
or purpose MUST NOT be accepted even if its hexadecimal suffix has valid
length.

The 22 V1 purposes are:

| Primitive | Registered digest domains |
| --- | --- |
| Replay | `security.replay.requester-key`, `security.replay.nonce` |
| Rate limit | `security.rate-limit.bucket-key` |
| Lease/claim | `broker.lease.resource-key`, `broker.lease.owner-key`, `broker.lease.attempt-key`, `broker.lease.mutation` |
| Idempotency | `broker.idempotency.key`, `broker.idempotency.payload-fingerprint`, `broker.idempotency.domain-mutation`, `broker.idempotency.outcome` |
| Outbox | `broker.outbox.stream-key`, `broker.outbox.idempotency-key`, `broker.outbox.event-key`, `broker.outbox.payload`, `broker.outbox.receipt-evidence` |
| Claim graph | `broker.claim-graph.source-stream-key`, `broker.claim-graph.source-fact`, `broker.claim-graph.projection-batch-key`, `broker.claim-graph.projection-batch`, `broker.claim-graph.projection-inverse`, `broker.claim-graph.rollback-batch-key` |

A purpose is deliberately shared only where the same key is transferred or
reused across operation fields, for example lease attempt keys, outbox event
keys, projection batch keys, and projection inverses. The registry maps every
digest-bearing input and committed-result field of all 13 operations to one
and only one purpose.

Canonicalization and token parsing return a closed error consisting of `code`
and `path`. The stable V1 keyspace codes are `invalid_type`, `unknown_field`,
`unknown_keyspace_version`, `unknown_digest_domain`, `invalid_namespace`,
`invalid_component_count`, `unknown_component_field`,
`unknown_component_type`, `component_order_mismatch`,
`component_type_mismatch`, `empty_component`, `component_too_large`,
`invalid_unicode`, `invalid_bytes`, `invalid_integer`, `unsafe_integer`,
`invalid_digest`, `digest_domain_mismatch`, and
`digest_namespace_mismatch`. Section 6.1 envelope parsing preserves the five
version/domain/token mismatch codes and otherwise reports its existing closed
schema errors.

### 4.2 Time and expiry

The backend-neutral contract is `a2a.shared-state.time/v1`. Its closed
vocabulary is `SHARED_STATE_TIME_V1_VALUES`; its parsers and pure evaluators
are in `packages/broker/src/shared-state-time-v1.ts`; and its public synthetic
golden tables are
`packages/broker/fixtures/shared-state-storage/time-v1-golden.json`. These
artifacts read no clock and implement no adapter, scheduler, storage, timer,
health middleware, or runtime callsite.

All absolute instants, persisted floors, tolerances, windows, and derived
durations in this time contract use the exact unit
`unix-epoch-millisecond` and the exact encoding
`canonical-unsigned-decimal-string`. The only valid text grammar is
`0|[1-9][0-9]*`: signs, leading zeroes, fractions, exponents, and JavaScript
numbers are not canonical inputs. An unsafe JavaScript number has the stable
error `unsafe_integer`; other numeric inputs have `invalid_integer`.
Absolute instants and floors range from `0` through
`9223372036854775807` (signed-int64 maximum). Durations range from `1` through
`31536000000` milliseconds. A declared backward-skew tolerance ranges from
`0` through `300000` milliseconds and has no implicit default. Parsing or
addition outside these limits fails closed; deriving an expiry above the
timestamp maximum returns `time_arithmetic_overflow`.

V1 supports exactly two profiles:

| Clock profile | Trusted observation | Persisted floor authority |
| --- | --- | --- |
| `sqlite-single-writer` | `clockAuthority=adapter-controlled`, `observationSource=adapter-clock` | The exclusive adapter owner persists the floor durably. |
| `shared-backend-server` | `clockAuthority=backend-server`, `observationSource=backend-server-clock` | The same shared backend updates the floor with linearizable authority. |

`TrustedSharedStateTimeObservationV1` is an adapter-internal provenance
envelope, not a transaction input. Its `trustBoundary` MUST be
`adapter-internal`, and its authority/source MUST exactly match its profile.
A literal claim of trust does not convert caller data into a trusted
observation. Section 6.1 command parsers continue to reject caller-selected
absolute time, observation, floor, tolerance, and expiry fields with
`caller_clock_forbidden`. Callers may supply only the already bounded relative
durations defined by an operation; the adapter derives the absolute expiry
from a successful trusted evaluation.

Each observation carries `observedAtUnixMs`, the durable
`persistedFloorUnixMs`, and `minimumExpectedFloorUnixMs`. The last field is
the greatest floor already observed in the current adapter lifecycle and is
`null` only for the first evaluation after open/reopen. Exact evaluation is:

| Condition, in precedence order | Effective result |
| --- | --- |
| `persistedFloor < minimumExpectedFloor` | `stored_floor_regression`; diagnostic clamp is `minimumExpectedFloor`; readiness is `not-ready`; writes and all logical time decisions are `forbidden`. |
| `observedAt > persistedFloor` | `observation_advanced`; `effectiveNow=observedAt`; `nextPersistedFloor=observedAt`; `floorWriteRequired=true`; ready and writes/logical decisions allowed only under the floor-persistence rule below. |
| `observedAt == persistedFloor` | `observation_at_floor`; hold the floor; ready and writes/logical decisions allowed. |
| `0 < persistedFloor-observedAt <= tolerance` | `backward_within_tolerance_clamped`; `effectiveNow=persistedFloor`; the floor never moves backward; ready and writes/logical decisions allowed. Equality with the declared tolerance is safe. |
| `persistedFloor-observedAt > tolerance` | `backward_beyond_tolerance`; diagnostic clamp is the persisted floor; readiness is `not-ready`; writes and all logical time decisions are `forbidden`. |

A forward result MUST durably persist `nextPersistedFloor` before or in the
same authoritative transaction as any dependent decision. It MUST NOT expose
the dependent write as committed if the floor did not commit. Every later
evaluation in that lifecycle supplies the prior result as its minimum
expected floor. Reopen supplies the durably stored floor with
`minimumExpectedFloorUnixMs=null`; therefore restart cannot reset time to
zero or to a fresh process observation. Missing, ambiguous, regressed, or
unavailable floor state is unsafe and never permits a local permissive
fallback.

Logical expiry is independent of physical cleanup:

- replay TTL, lease, and explicitly allowed idempotency-retention records are
  active if and only if `now < expiresAt`; at equality they are expired;
- a rate-window entry counts if and only if
  `eventAt > now - window`; at equality it is excluded. If `window > now`,
  the conceptual threshold is before Unix epoch and every valid non-negative
  `eventAt` counts;
- idempotency expiry is available only as
  `idempotency-explicit-retention`. This boundary evaluator does not create an
  implicit retention policy or authorize expiry for irreversible effects;
- delayed cleanup cannot extend logical validity, and cleanup MUST NOT remove
  a logically active record. Presence or cleanup state is intentionally not
  an input to the logical evaluator, so cleanup cannot change its answer.

The five stable evaluation reasons are `observation_advanced`,
`observation_at_floor`, `backward_within_tolerance_clamped`,
`backward_beyond_tolerance`, and `stored_floor_regression`. The closed parser
and evaluator error vocabulary is `invalid_type`, `unknown_field`,
`unknown_time_version`, `invalid_discriminant`, `unknown_clock_profile`,
`profile_mismatch`, `clock_authority_mismatch`,
`observation_source_mismatch`, `unit_mismatch`,
`integer_encoding_mismatch`, `invalid_integer`, `unsafe_integer`,
`integer_overflow`, `tolerance_out_of_range`, `duration_out_of_range`,
`time_not_ready`, and `time_arithmetic_overflow`.

### 4.3 Errors and retries

- A known duplicate/replay, conflicting idempotency fingerprint, stale fencing
  token, or invalid state transition MUST return a stable domain rejection.
- Store unavailability, lock timeout, lost ownership, uncertain commit, or
  partition MUST return a retryable unavailable result, not a false
  authorization or false rate-limit decision.
- An ambiguous write result MUST be resolved by reading the idempotency outcome
  before retrying the mutation.
- Liveness MAY remain healthy while readiness is false. Liveness MUST never be
  used as evidence that shared-state guarantees hold.

## 5. State primitive contracts

### 5.1 Nonce and replay

| Property | Contract |
| --- | --- |
| Source of truth | **Current:** one `A2AHttpSignatureReplayCache` map per broker process. **V1 adapter:** `(namespace, keyDigest, nonceDigest)` consumption record. Raw key IDs and nonces MUST NOT be stored in observability output. |
| Atomicity boundary | Check-unexpired and insert-if-absent MUST be one atomic operation. Two concurrent consumes of the same tuple MUST yield exactly one `accepted` and all others `replay`. |
| Consistency model | Linearizable per replay tuple. Cluster-wide wording is forbidden unless every serving process uses the same conforming adapter authority. |
| TTL / expiry | Record remains rejecting through the signed request expiry. It becomes logically absent at `now >= expiresAt`; early eviction is forbidden. Capacity pressure MUST deny or shed new requests rather than evict an unexpired nonce silently. |
| Restart behavior | Current single-process grades reset the cache and MUST report reset risk. A conforming durable adapter MUST preserve unexpired records and its clock floor across restart. |
| Partition behavior | A process that cannot reach the authoritative replay state MUST reject the protected request with retryable unavailable; it MUST NOT accept on a local fallback. |
| Fail-closed behavior | Replay is rejected. Unknown/ambiguous state is unavailable. Only confirmed first consumption is accepted. |
| Observability | Report `source=process|adapter`, `durability=volatile|durable`, `continuity=reset|preserved|unknown`, `resetRisk`, epoch age, capacity pressure band, and enumerated reset/error reason. Never report nonce/key/identity values or digests. |
| Adapter lifecycle invariant | Consumption is unavailable before adapter `ready`, while `draining`, or after `closed/failed`. Reopen MUST preserve every unexpired accepted tuple and the same result for its retry. |

### 5.2 Rate limit

| Property | Contract |
| --- | --- |
| Source of truth | **Current:** per-process `InMemoryRateLimiter` buckets. **V1 adapter:** namespace/bucket-key digest plus timestamped cost entries or an equivalent representation that produces the exact configured sliding-window decision. |
| Atomicity boundary | Prune logically expired cost, calculate in-window cost, conditionally reserve the new cost, and return limit/remaining/reset MUST be one atomic operation per bucket. |
| Consistency model | Linearizable per bucket. No global order between unrelated buckets is required. Limits MUST be enforced against total traffic reaching all processes that claim the same HA grade. |
| TTL / expiry | An accepted cost counts while `timestamp > now - window`. It stops counting exactly at the boundary. Physical rows MAY outlive the window for bounded cleanup only. |
| Restart behavior | Current counters reset and reset risk MUST be visible. A conforming durable adapter MUST retain in-window cost and decision continuity through restart. |
| Partition behavior | Security-sensitive routes MUST return retryable unavailable when the authoritative bucket cannot be evaluated. A local permissive bucket is forbidden. An explicitly classified low-risk route MAY use a separately specified fail-open policy, but V1 defines none. |
| Fail-closed behavior | Confirmed exhaustion returns rate-limited. Unknown state returns unavailable, not a fabricated `remaining` value. |
| Observability | Report window/limit configuration, volatile/durable source, reset risk, allowed/denied totals, coarse pressure band, and store error counts. Do not expose bucket keys, identities, IPs, digests, or a “busiest” list. |
| Adapter lifecycle invariant | Reservations are accepted only in `ready`. Reopen MUST reproduce the same in-window count from durable state. Adapter replacement MUST not create an empty overlapping window. |

### 5.3 Lease and task claim

`claimed` is currently a durable task status plus heartbeat/stale-requeue
policy; it is not a distributed lease. V1 makes the missing fencing explicit.

| Property | Contract |
| --- | --- |
| Source of truth | Durable task row containing claim state, opaque owner reference, `attemptId`, monotonically increasing `fencingToken`, `leaseExpiresAt`, and version. |
| Atomicity boundary | Verify claimable status/version, allocate the next fencing token, set owner/attempt/expiry, and append the claim audit/outbox effect MUST commit in one transaction. Renewal or terminal mutation MUST compare owner, attempt, and fencing token in that transaction. |
| Consistency model | Linearizable per task/resource. At most one unexpired claim is authoritative. Stale workers may execute locally but MUST be unable to commit with an old fence. |
| TTL / expiry | Lease expires logically at `now >= leaseExpiresAt`. Expiry alone does not transfer ownership; one atomic reap/requeue or new-claim transition must do so and advance the fence. |
| Restart behavior | Claim, expiry, attempt, and fence survive durable restart. On volatile `single-process`, startup recovery MUST explicitly reclassify incomplete claims; it MUST NOT invent continuity. |
| Partition behavior | A worker unable to renew becomes stale. The old fence remains unable to commit after a new claim. A broker unable to reach the authority MUST not grant, renew, requeue, or complete a claim. |
| Fail-closed behavior | Claim conflict, stale fence, owner mismatch, or unknown commit state rejects mutation. Unsupported multi-process topology cannot serve claim routes. |
| Observability | Report aggregate active/expiring/stale claims, renewal failures, fencing rejections, and oldest-age bands. Never expose owner/worker/task identities in public health. Operator-only task APIs may retain their existing authorization. |
| Adapter lifecycle invariant | A claim token is scoped to one adapter authority and lifecycle epoch. Draining stops new claims before close; close waits for committed writes or reports failure. Reopen never decreases a resource's fencing token. |

### 5.4 Idempotency

| Property | Contract |
| --- | --- |
| Source of truth | Durable `(namespace, keyDigest)` record with payload fingerprint, stable outcome code, safe result reference/digest, creation time, and retention boundary. |
| Atomicity boundary | Compare/reserve key, apply the domain mutation, append its outbox/audit effects, and persist the stable outcome MUST be one transaction. A durable “pending” reservation without the corresponding mutation/outcome is forbidden. |
| Consistency model | Linearizable per idempotency key. Same key + same fingerprint returns the original outcome; same key + different fingerprint fails `idempotency_conflict`. |
| TTL / expiry | Keys protecting externally visible or irreversible effects MUST NOT expire while a retry or retained effect can recur. Other namespaces require an explicit, versioned retention value. No implicit default TTL is allowed. |
| Restart behavior | Durable grades return the same outcome after restart. Volatile idempotency is allowed only for explicitly local, non-effecting operations and MUST be labeled volatile. |
| Partition behavior | A process unable to read/commit the authoritative record MUST not perform the protected mutation. On timeout, retry first resolves the prior outcome using the same key/fingerprint. |
| Fail-closed behavior | Changed fingerprint, unknown outcome, or split atomic boundary blocks the mutation. “Best effort” dedupe is not V1 conformance. |
| Observability | Report aggregate new/replayed/conflict/unknown counts and retention-policy version. Do not expose keys, fingerprints, result references, payloads, or identities. |
| Adapter lifecycle invariant | Outcomes remain stable across drain, close, and reopen until their explicit retention boundary. Backend migration MUST preserve both key and fingerprint semantics before cutover. |

#### 5.4.1 Closed V1 namespace and retention registry

The backend-neutral registry identifier is
`a2a.shared-state.idempotency/v1`. Its closed vocabulary, canonical catalog,
parser, and evaluator are in
`packages/broker/src/shared-state-idempotency-v1-values.ts` and
`packages/broker/src/shared-state-idempotency-v1.ts`; the public, non-secret
golden catalog is
`packages/broker/fixtures/shared-state-storage/idempotency-v1-golden.json`.
These artifacts are contract/parser-only. Every catalog authority is labeled
`current-durable-partial`, the catalog says
`runtimeIntegration=not-implemented`, and no current source is claimed to
implement or call `SharedStateStorageAdapterV1`.

The complete source inventory intended to be upgraded through the planned
`executeIdempotent` boundary is:

| Current durable-but-partial authority | Source evidence | Planned V1 namespace | Exact retention-policy version |
| --- | --- | --- | --- |
| Task create replay by caller-selected task ID | `InMemoryA2ABroker.createTask`; durable `broker_tasks` table | `broker.task.create` | `task-create-effects.v1` |
| Accepted-task wake key and stable wake decision stored on the task | `InMemoryA2ABroker.planAcceptedTaskWake`; `taskWakeSchema` | `broker.task.wake` | `task-wake-effects.v1` |
| Terminal task status mutation plus terminal outbox projection | `completeTask`/terminal mutation source; `terminalTaskEventOutbox.enqueue`; durable `broker_terminal_outbox` table | `broker.task.terminal` | `task-terminal-effects.v1` |
| One-shot live-approval consumption key | `SqliteBrokerStateStore.consumeLiveApprovalKey`; durable `broker_live_approval_consumptions` table | `broker.live-approval.consume` | `live-approval-effects.v1` |
| Review-lineage source/ledger key, fingerprint, outcome, and mutation | `ReviewLineageObservationStore` payload fingerprint and `idempotency_key` ledger | `broker.review-lineage.source` | `review-lineage-effects.v1` |
| Cross-broker Terminal Brief projection key/fingerprint plus operator outbox rows | `CrossBrokerTerminalBriefProjectionStore.ingest`; broker enqueue and snapshot restore | `broker.terminal-brief.cross-broker-ingest` | `cross-broker-terminal-brief-effects.v1` |

The existing authorities prove why each namespace is required; they do not
prove V1 conformance. For example, current task-create replay does not compare a
V1 payload fingerprint, and several current effects are not committed through
the V1 domain-mutation/outbox transaction. A later integration MUST upgrade the
whole authority atomically and MUST NOT layer a second independent
idempotency decision over the current one.

Every registered entry pins:

- `effectKind=domain-mutation-with-outbox`;
- an exact `effectClass` of `externally-visible` or `irreversible`;
- `durability=durable` and
  `expiryPosture=non-expiring-until-prune-proof`;
- one closed retry-horizon token and one closed retained-effect-horizon token
  specific to the source authority;
- `requiredEffectDependency=outbox-and-retained-effect`;
- all four prune preconditions:
  `retry-sources-provably-gone`, `outbox-effects-provably-gone`,
  `retained-effects-provably-gone`, and
  `migration-and-rollback-preservation-proved`; and
- `migrationRollbackPreservationRule=preserve-key-fingerprint-outcome-retention-and-effect-links`.

There is no wildcard, caller extension, default retention version, free-form
policy value, or time-bounded entry in V1. An externally visible or irreversible
entry is invalid unless it is durable, non-expiring, depends on both outbox and
retained effects, and carries every retry/effect/migration prune proof. The
catalog parser permits a future `time-bounded` registration only when its
effect class is exactly `reversible` or `non-effecting` and its boundary kind is
exactly `idempotency-explicit-retention`. Evaluating such a registration
requires a valid `a2a.shared-state.time/v1` logical boundary; absence, another
boundary kind, another time version, or supplying a boundary to a non-expiring
entry fails closed.

The planned Section 6.1 `executeIdempotent` command parser alone evaluates this
catalog before digest binding. It returns these exact storage-contract codes
and paths:

| Condition | Stable code | Stable path |
| --- | --- | --- |
| Non-canonical case, Unicode, wildcard, or malformed namespace | `invalid_idempotency_namespace` | `input.namespace` |
| Canonical but unregistered namespace | `unknown_idempotency_namespace` | `input.namespace` |
| Non-canonical retention-policy version | `invalid_idempotency_retention_policy_version` | `input.retentionPolicyVersion` |
| Canonical but unregistered retention-policy version | `unknown_idempotency_retention_policy_version` | `input.retentionPolicyVersion` |
| Registered namespace paired with another namespace's retention version | `idempotency_retention_policy_mismatch` | `input.retentionPolicyVersion` |
| Effect kind not registered for the exact pair | `idempotency_effect_policy_mismatch` | `input.effect.kind` |

The catalog parser/evaluator's complete error vocabulary is `invalid_type`,
`unknown_field`, `invalid_value`, `unknown_catalog_version`,
`duplicate_namespace`, `duplicate_retention_policy_version`,
`duplicate_authority`, `unknown_authority`, `authority_mapping_mismatch`,
`unsafe_expiry_policy`, `expiry_boundary_requirement_mismatch`,
`invalid_namespace`, `unknown_namespace`,
`invalid_retention_policy_version`, `unknown_retention_policy_version`,
`retention_policy_mismatch`, `effect_policy_mismatch`,
`expiry_boundary_required`, `expiry_boundary_forbidden`, and
`invalid_expiry_boundary`. Its successful reason codes are
`registered_policy`, `non_expiring_until_prune_proof`, and
`explicit_time_v1_boundary_accepted`.

Replay, rate, and lease commands continue to use their existing generic
namespace grammar. Outbox append/receipt/ACK and claim-graph source/projection
idempotency remain separate Section 6.1 operations and are not aliases for
`executeIdempotent`. The outbox operations use the separate closed registry in
section 5.5.1; claim-graph operations retain their generic namespace grammar.

### 5.5 Terminal outbox ordering

| Property | Contract |
| --- | --- |
| Source of truth | Durable outbox row with stable event ID, `streamKey`, monotonically increasing `streamSequence`, payload, receipt/ACK state, and retention metadata. |
| Atomicity boundary | The domain transition and its outbox append MUST commit together. Idempotent retry MUST return the original event ID and sequence. ACK/receipt mutation is a separate atomic compare-and-set on that event. |
| Consistency model | Total order is required within one `streamKey`; sequences are unique and strictly increasing. Gaps are allowed and MUST NOT be interpreted as data loss. No global total order between streams is promised. Consumption is at-least-once until receipt-confirmed ACK. |
| TTL / expiry | Unacknowledged events do not expire. Receipt-confirmed events may be pruned only under a separately approved retention policy and checkpoint safety proof. ACK is not deletion. |
| Restart behavior | Event IDs, sequence, cursor reconciliation, receipt/ACK state, and idempotency outcomes survive restart. A restart MUST not reorder retained rows or reset a stream sequence. |
| Partition behavior | Producers fail the entire domain transaction if append is unavailable. Consumers may receive duplicates after reconnect but not an order reversal within a stream. ACK unavailable means the event remains replayable; provider acceptance is still not ACK. |
| Fail-closed behavior | If atomic domain+append cannot be proved, the domain mutation fails. Unknown ACK status never permits prune or suppresses replay. |
| Observability | Report per-state aggregate backlog, oldest age, sequence high-water/lag, duplicate replays, and order violations. Health MUST omit payloads, event IDs, stream keys, task/worker/provider identities, and receipt IDs. |
| Adapter lifecycle invariant | Draining stops new appends, completes or rolls back in-flight transactions, and keeps reads/reconciliation available until close. Migration preserves stable IDs, per-stream order, and ACK state exactly. |

#### 5.5.1 Closed V1 stream and policy registry

The backend-neutral registry identifier is
`a2a.shared-state.outbox/v1`. Its closed vocabulary, source inventory,
canonical catalog, parser, and pure evaluators are in
`packages/broker/src/shared-state-outbox-v1-values.ts` and
`packages/broker/src/shared-state-outbox-v1.ts`. The public, non-secret golden
fixture is
`packages/broker/fixtures/shared-state-storage/outbox-v1-golden.json`.
These artifacts are contract/parser-only: the catalog says
`runtimeIntegration=not-implemented`, and no current class, table, producer,
receipt route, or cleanup path implements or calls the planned adapter
boundary.

The complete current durable-but-partial inventory intended to be represented
by this boundary has one authority:

| Current authority | Producers and current event-key derivation | Current order/sequence authority | Current receipt/ACK authority | Current retention dependency |
| --- | --- | --- | --- | --- |
| `TerminalTaskEventOutbox` plus `broker_terminal_outbox` | Local terminal task event: `taskId + status + completedAt`; cross-broker projection evidence: `parentRoundId + originBrokerId + child-key + status + notification-owner`; separate parent-broker operator row: the projection stable ID with the `cross-broker-operator` prefix | Broker-local array insertion order, restored from SQLite `created_at, id` order. Local task rows carry a process-local task-event ID; both cross-broker rows carry `0`. Neither is a durable per-stream sequence. | The outbox object and hot row preserve receipt/ACK state. Current-session-visible, operator-visible, or operator-confirmed evidence can ACK an operator-facing row; projection evidence rows cannot ACK. Provider sent/accepted state is not receipt-confirmed ACK. | SQLite planning retains every unacknowledged row. The in-memory outbox remains partial because its `2 * maxEvents` hard ceiling can drop the oldest unacknowledged row. This is explicitly not V1 retention conformance. |

The current authority proves the inventory, producer, stable-ID,
receipt/ACK, restart, and partial-retention facts above. It does not prove
domain+append atomicity, adapter sequence allocation, multi-process order,
non-expiring unacknowledged retention, or V1 conformance.

The planned catalog has no default namespace, default ordering scope,
wildcard, or extension entry. All three exact registrations use:

- namespace `broker.terminal-outbox`;
- stream-key digest domain `broker.outbox.stream-key`;
- component 0 exactly
  `{field: "streamType", type: "utf8", value:
  "broker-terminal-outbox"}`;
- component 1 exactly
  `{field: "streamId", type: "utf8", value: <broker-authority-id>}`, where
  the value is a non-empty lowercase ASCII identifier matching
  `[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*`;
- ordering scope `total-within-exact-stream-key`;
- sequence authority `adapter-allocated-per-exact-stream-key`;
- monotonicity `unique-strictly-increasing-gaps-allowed`;
- cross-stream posture `no-global-cross-stream-order`; and
- caller sequence policy `forbidden`.

Thus different producer purposes on the same exact broker stream share one
total order. A different `streamId` is a different stream; no comparison or
global order is promised. The canonical typed components are independently
length-framed through `a2a.shared-state.keyspace/v1`, and the supplied
`streamKeyDigest` must equal the derived digest.

| Planned event purpose | Stable event-ID authority | Retention policy | Receipt policy | ACK policy |
| --- | --- | --- | --- | --- |
| `task-terminal-notification` | `task-id-status-completed-at` | `task-terminal-outbox-retention.v1` | `terminal-notification-receipt.v1` | `terminal-notification-ack.v1` |
| `cross-broker-projection-evidence` | `cross-broker-projection-stable-id` | `cross-broker-projection-evidence-retention.v1` | `cross-broker-projection-evidence-receipt.v1` | `cross-broker-projection-evidence-ack-forbidden.v1` |
| `cross-broker-operator-notification` | `cross-broker-operator-row-stable-id` | `cross-broker-operator-outbox-retention.v1` | `terminal-notification-receipt.v1` | `terminal-notification-ack.v1` |

Every entry pins
`same-key-and-payload-return-original-event-id-and-sequence`. A retry with the
same append idempotency key and payload returns the originally committed event
ID and stream sequence; it does not allocate either again. Callers never
select, predict, or compare-and-set a stream sequence.

For the two operator-facing purposes, provider-sent or provider-accepted
evidence may only preserve `pending -> pending`; it cannot produce
`confirmed` or ACK. Current-session-visible, operator-visible, or
operator-confirmed evidence may perform `pending -> confirmed`, and only a
confirmed receipt with that evidence may ACK. Delivery failure may perform
`pending -> failed` without ACK. The projection-evidence purpose permits only
its evidence-only pending state and rejects every ACK attempt.

All entries are
`unacknowledged-non-expiring-until-prune-proof`. Provider acceptance is not an
expiry or prune proof, and ACK is not deletion. The projection-evidence entry
is not pruneable in V1. An operator-facing acknowledged row is only
prune-eligible after all of these are proved: receipt-confirmed ACK, consumer
checkpoint safety, absence of idempotency retry sources, migration/rollback
preservation, and a separate recorded retention approval. The evaluator only
classifies retention; it does not read time, ACK, or prune.

Migration and rollback must preserve the exact namespace/key, per-stream
high-water, stable event ID, append idempotency binding, receipt/ACK state, and
every unacknowledged row. A target unable to represent any of those fields
cannot become authoritative.

Only the Section 6.1 `appendOutbox`, `updateOutboxReceipt`, and
`acknowledgeOutbox` command parsers evaluate this catalog. They reject
non-canonical or unknown namespace, unknown purpose, malformed/reordered/
non-canonical key components, a digest not derived from those components,
ordering-scope mismatch, caller sequence fields, unknown or cross-paired
retention/receipt/ACK policies, forbidden receipt transitions, provider
acceptance as ACK, and projection-evidence ACK. Stable parser codes retain the
exact failing path under `input`:

| Condition | Stable code |
| --- | --- |
| Non-canonical / unknown stream namespace | `invalid_outbox_stream_namespace` / `unknown_outbox_stream_namespace` |
| Unknown event purpose | `unknown_outbox_event_purpose` |
| Invalid key envelope / component count / component order or literal / component value | `invalid_outbox_stream_key` / `outbox_stream_key_shape_mismatch` / `outbox_stream_key_component_mismatch` / `invalid_outbox_stream_key_component` |
| Derived digest mismatch | `outbox_stream_key_digest_mismatch` |
| Ordering scope or caller sequence | `outbox_ordering_scope_mismatch` / `caller_outbox_sequence_forbidden` |
| Invalid / unknown / cross-paired retention policy | `invalid_outbox_retention_policy_version` / `unknown_outbox_retention_policy_version` / `outbox_retention_policy_mismatch` |
| Invalid / unknown / cross-paired receipt policy | `invalid_outbox_receipt_policy_version` / `unknown_outbox_receipt_policy_version` / `outbox_receipt_policy_mismatch` |
| Invalid / unknown / cross-paired ACK policy | `invalid_outbox_acknowledgment_policy_version` / `unknown_outbox_acknowledgment_policy_version` / `outbox_acknowledgment_policy_mismatch` |
| Receipt transition, forbidden ACK, provider acceptance as ACK, or other non-confirming ACK evidence | `outbox_receipt_transition_mismatch` / `outbox_acknowledgment_forbidden` / `outbox_provider_acceptance_not_ack` / `outbox_acknowledgment_evidence_mismatch` |

### 5.6 Claim-graph read model

The claim graph is the #1504 scenario folded in from the #1635 follow-up. It is
a projection over existing artifact/audit/task facts, not a second writable
truth and not a new infrastructure claim.

Typed nodes are `Entity`, `Claim`, `Source`, `Artifact`, `AgentRun`, and
`Evaluation`. Edges carry provenance and the exact immutable source fact(s)
that justify the edge.

| Property | Contract |
| --- | --- |
| Source of truth | Authenticated, immutable artifact/audit/task source facts. Graph nodes/edges and evaluation paths are a derived read model with source references, projection version, and checkpoint. |
| Atomicity boundary | Appending a source fact and its monotonic source sequence is atomic. Applying one projection batch, all its nodes/edges, its batch provenance, and checkpoint advance is a second atomic transaction. The two boundaries MUST NOT be represented as one transaction when projection is asynchronous. |
| Consistency model | Source facts are strongly consistent per source stream. Graph queries are monotonic/eventually consistent and return `asOfSourceSequence`, projection version, lag, and completeness. `no_evidence_path` is valid only at a complete checkpoint; unavailable/incomplete MUST be distinct results. |
| TTL / expiry | Claims and provenance have no implicit TTL. Retention requires an approved policy and durable tombstone/source marker. Expired leases or transient evaluations do not erase historical provenance. |
| Restart behavior | Projection resumes from its durable checkpoint or rebuilds deterministically from source facts. It MUST NOT advance the checkpoint past an unapplied batch. |
| Partition behavior | Source append fails if its authority is unavailable. A partitioned projection may serve an explicitly stale result with checkpoint/lag, but finalization that requires a proof path MUST fail closed on incomplete or unavailable projection. |
| Fail-closed behavior | The evaluator distinguishes `path_found`, `no_evidence_path`, `projection_incomplete`, and `projection_unavailable`. Only the first two are evidence judgments. A false merge remains reversible by exact projection batch without deleting source truth. |
| Observability | Report projection version, source/checkpoint high-water marks, lag/age bands, failed batches, rollback count, and completeness. Never expose claim text, node/edge IDs, source content, artifact paths, agent identities, or provenance payloads in health. |
| Adapter lifecycle invariant | Projection writes are idempotent by `(projectionVersion, batchId)`. Reopen resumes at the same checkpoint. Rollback applies the recorded inverse/tombstone set for exactly one batch and leaves immutable source facts intact. |

Cross-task acceptance for this scenario is: a query equivalent to “what is the
evidence path for this claim?” can be answered from typed graph state and
source references alone, with an explicit completeness result, and an injected
false projection batch can be reversed deterministically.

## 6. `SharedStateStorageAdapterV1`

### 6.1 Contract identity

The planned adapter contract identifier is
`a2a.shared-state.storage/v1`. No current class or backend may claim this
identifier until it passes the full checklist.

A conforming adapter exposes:

```text
metadata() -> {
  contractVersion: "a2a.shared-state.storage/v1",
  implementationVersion,
  backendClass: "sqlite-single-writer" | "shared",
  durability: "durable",
  writerModel: "single" | "multi",
  schemaVersion,
  capabilities
}

open(expected) -> lifecycle "ready" | error
withTransaction(callback(tx)) -> committed result | rolled-back error
query(request) -> versioned result with consistency/completeness metadata
health() -> secret-safe AdapterHealthV1
drain(deadline) -> "draining" then quiescent | error
close() -> "closed" | error
```

`capabilities` MUST affirm all of:

- atomic compare-and-set;
- linearizable per-key operations;
- durable logical expiry and clock-floor protection;
- monotonic fencing tokens;
- atomic idempotency + domain mutation + outbox append;
- stable per-stream outbox ordering and ACK state;
- durable projection batches/checkpoints and exact batch rollback; and
- exclusive singleton ownership when `writerModel=single`.

The callback transaction exposes only versioned, namespace-scoped operations:

```text
consumeReplayNonce(...)
reserveRateLimitCost(...)
claimLease(...) / renewLease(...) / mutateWithFence(...) / releaseLease(...)
executeIdempotent(...)
appendOutbox(...) / updateOutboxReceipt(...) / acknowledgeOutbox(...)
appendGraphSource(...)
applyGraphProjectionBatch(...) / rollbackGraphProjectionBatch(...)
```

Operation inputs and outputs MUST be closed, validated unions. Unknown fields,
unknown operation versions, and capability downgrades fail closed. Arbitrary
SQL, backend commands, credentials, or caller-selected clock values are not
part of the contract. In particular, the section 6.1 transaction parser
rejects absolute `now`, timestamp, expiry, event-time, trusted-observation,
persisted-floor, effective-time, and skew-tolerance field spellings at any
nested path with `caller_clock_forbidden`. Relative operation durations such
as `ttlMs`, `windowMs`, and `leaseDurationMs` are not transaction timestamps.
`executeIdempotent` additionally requires an exact registered
`a2a.shared-state.idempotency/v1` namespace, retention-policy version, and
effect-kind combination. The three outbox commands separately require an
exact registered `a2a.shared-state.outbox/v1` namespace, event purpose, typed
stream key, ordering scope, and retention/receipt/ACK policy combination.
Neither restriction changes generic namespace handling for replay, rate,
lease, or graph operations, and neither registry is an alias for the other.

### 6.2 Transaction and lifecycle invariants

- `withTransaction` commits all declared effects or none.
- Nested or cross-adapter transactions are forbidden in V1.
- Reads that make an authorization, claim, finalization, ACK, prune, or
  cutover decision MUST declare the required consistency; an adapter unable to
  meet it returns unavailable.
- `open` validates contract/schema version, clock safety, topology ownership,
  migration state, and capabilities before `ready`.
- All state-changing calls reject outside `ready`.
- `drain` stops new writes and reports whether every accepted write reached a
  known committed or rolled-back result.
- `close` releases ownership only after drain. Crash expiry never permits a
  stale session to write because every mutating command is fenced.
- Adapter replacement preserves keys, fingerprints, fences, sequence numbers,
  expiry instants, projection checkpoints, and stable outcomes.

### 6.3 Backend applicability

A later SQLite adapter can satisfy V1 with one exclusive serving owner,
`BEGIN IMMEDIATE` transactions, persisted clock/fence/sequence metadata, and
the existing optional FIFO worker writer. It remains
`writerModel=single`.

A future shared adapter can satisfy V1 only if its backend provides equivalent
atomicity and consistency to all serving processes. The implementation may use
transactions, compare-and-set, or scripts internally, but weaker observable
semantics are not allowed.

This common contract does not imply that either adapter has been implemented,
that a generic existing SQLite store already conforms, or that a future shared
backend has been selected or provisioned.

## 7. Startup, readiness, and health

### 7.1 Startup/topology behavior

Before binding a serving socket, a later implementation MUST:

1. parse the configured grade and expected process/replica intent;
2. open the adapter and validate version/capabilities/schema/clock;
3. acquire a fenced singleton ownership record for single-process grades;
4. reject expected replicas greater than one for single-process grades;
5. reject `shared-state-ha` if no approved conforming shared adapter is
   configured; and
6. publish the effective grade only after these checks.

Where a platform cannot reveal replica intent, the operator MUST provide it
explicitly and the singleton fence remains mandatory. If a second process or
lost fence is detected after startup, the process MUST stop admitting
non-liveness traffic immediately and begin drain/shutdown.

### 7.2 Endpoint contract

- `GET /livez` indicates only that the process/event loop can respond. It MAY
  remain `200` during a state partition and MUST contain no state guarantees.
- Planned `GET /readyz` returns `200` only when the configured supported grade
  is serviceable. It returns `503` with bounded reason codes for ownership
  conflict, unsupported topology, adapter unavailable, schema/version
  mismatch, unsafe clock, incomplete migration, or lost fence.
- `GET /health` exposes diagnostic detail but is not an authorization or
  cutover gate by itself.
- While readiness is false, every non-liveness route MUST return `503
  state_authority_unavailable` (or the more specific bounded code) without
  applying a state mutation.

The supported `single-process` and current `single-writer-durable` postures may
be ready while explicitly reporting volatile replay/rate-limit reset risk.
Any policy requiring durable security continuity MUST treat that risk as
not-ready until a V1 adapter supplies it.

### 7.3 Secret-safe signal shape

The planned `stateContract` health/readiness projection is:

```json
{
  "specVersion": 1,
  "configuredGrade": "single-process",
  "effectiveGrade": "single-process",
  "gradeDefaulted": false,
  "serving": true,
  "reasonCodes": [],
  "adapter": {
    "contractVersion": null,
    "backendClass": "legacy-process",
    "lifecycle": "ready",
    "durability": "volatile",
    "writerModel": "single"
  },
  "topology": {
    "expectedProcessCount": 1,
    "ownership": "held"
  },
  "primitives": {
    "replay": {
      "source": "process",
      "durability": "volatile",
      "continuity": "reset",
      "resetRisk": true,
      "epochAgeSec": 120,
      "lastResetReason": "process_start"
    },
    "rateLimit": {
      "source": "process",
      "durability": "volatile",
      "continuity": "reset",
      "resetRisk": true,
      "epochAgeSec": 120,
      "lastResetReason": "process_start"
    }
  }
}
```

Allowed reset reasons are `process_start`, `adapter_reopen`,
`operator_reset`, `migration`, and `unknown`. The real output may add
versioned aggregate fields, but it MUST NOT contain raw or hashed nonces,
bucket keys, requester/worker/task/lease identities, event/receipt IDs,
payloads, claim text, artifact paths, credentials, database locations, or
provider identifiers. Small-cardinality aggregates SHOULD be coarsened where
they could reveal one actor.

## 8. Acceptance boundaries

The packet is ready for approval when the six documents exist, directly
affected public docs link here without overstating support, and documentation
checks pass. Approval of this packet authorizes only a later source
implementation proposal.

Runtime implementation is not complete until every unchecked conformance item
in [checklist.md](checklist.md) passes. Migration and operational rollout are
separate stages in [plan.md](plan.md), each with separate authorization.
