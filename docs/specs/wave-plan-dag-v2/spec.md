# WavePlanDagV2 proposal and dry-run contract

Status: source-only P2-C contract slice. Refs #1635.

This package defines the first public-safe `WavePlanDagManifestV2` proposal
and deterministic `WavePlanDagDryRunReceiptV2`. It is a declarative rehearsal
contract only. A model may propose the same closed manifest that an operator
may propose; it may not supply orchestration code and receives no execution
authority.

## 1. Scope and non-goals

Wave-plan v1 remains linear, live, and unchanged. V2 is not a conversion or
upgrade path for v1. This slice adds no store, schema, migration, route,
runtime producer or consumer, exchange write, dispatcher integration,
automatic dispatch, deployment, or issue completion.

There is no claim, retry, finalizer, success, live, or execution authority in
this contract. Every future dispatch or advance, if separately integrated,
would remain an explicit operator or hub action. `ready` is only a signal.

## 2. Public-safe closed data

Every object is closed: an unlisted field is malformed. There are no labels,
metadata maps, extension points, or caller-defined strings.

The only caller-selected strings admitted to a manifest are:

- `manifestAlias`: `wpm_` followed by exactly 16 lowercase hexadecimal
  characters;
- `stageId`: `stg_` followed by exactly 8 lowercase hexadecimal characters;
- stage `manifestAlias`: `mft_` followed by exactly 16 lowercase hexadecimal
  characters; and
- `reviewedManifestDigest`: `sha256:` followed by exactly 64 lowercase
  hexadecimal characters.

Aliases MUST be randomly assigned or selected from a reviewed public-safe
registry. They MUST NOT encode an identity, prompt, payload, path, URL,
timestamp, or private value. A reviewed manifest digest MUST bind a separately
reviewed, public-safe stage manifest. This slice does not fetch or execute that
manifest.

Worker, person, requester, model instance, provider, and account identities
are forbidden. Prompts, payloads, paths, URLs, timestamps, arbitrary labels,
maps, and extensions are forbidden. Any field for a command, script, code,
shell, executable, entry point, arguments, environment, or interpreter is
forbidden. A digest of forbidden or private content is also forbidden.

`proposalSource` is the closed class enum `model` or `operator`; it is not an
identity. Both classes submit exactly the same declarative shape and receive
the same absence of authority.

## 3. `WavePlanDagManifestV2`

The manifest has exactly these fields:

| Field | Exact rule |
| --- | --- |
| `kind` | `WavePlanDagManifestV2` |
| `version` | integer `2` |
| `proposalSource` | `model` or `operator` |
| `manifestAlias` | canonical `wpm_` alias |
| `stages` | 1 through 32 closed stage entries |
| `edges` | 0 through 64 closed edge entries |
| `limits` | the fixed limits below |
| `autoDispatch` | `false` |
| `operatorAdvanceRequired` | `true` |
| `dryRunRequired` | `true` |
| `executionAuthority` | `none` |
| `claimAuthority` | `none` |
| `retryAuthority` | `none` |
| `finalizerAuthority` | `none` |
| `successAuthority` | `none` |
| `liveAuthority` | `none` |
| `manifestDigestDomain` | `a2a.wave-plan-dag-v2.manifest.v2` |
| `manifestDigest` | the exact digest defined in section 6 |

`limits` is not configurable and has exactly:

```json
{
  "maxStages": 32,
  "maxEdges": 64,
  "maxDepth": 8,
  "maxFanIn": 8,
  "maxFanOut": 8
}
```

A stage entry has exactly `stageId`, `manifestAlias`,
`reviewedManifestDigest`, and `joinPolicy`. Stage IDs and stage manifest
aliases are unique. The unique structural root uses `joinPolicy=root`.
Every other stage uses `all_matching` or `any_matching`.

An edge has exactly `fromStageId`, `toStageId`, and `when`. `when` is one of:

- `gate_passed`: match only a terminal `gate_passed` outcome;
- `gate_failed`: match only a terminal `gate_failed` outcome;
- `any_terminal`: match either terminal gate outcome.

No other terminal state, result, expression, predicate, or embedded logic is
admitted.

## 4. Graph invariants

Validation precedes digest admission and dry-run. A manifest MUST have:

- unique canonical stage IDs;
- exactly one structural root and at least one structural leaf;
- known edge endpoints;
- no self-edge;
- no repeated `(fromStageId,toStageId)` pair, even with a different `when`;
- full directed reachability from the root;
- no cycle;
- at most 32 stages and 64 edges;
- fan-in and fan-out at most 8; and
- longest root-to-stage path at most 8 edges.

Topological order uses Kahn's algorithm. Whenever more than one stage is
available, the lexicographically smallest ASCII `stageId` is selected. Stage
and edge input array order has no effect on this order.

Duplicate or conditional variants of the same endpoint pair are an ambiguous
join input and are rejected. A cycle, unreachable component, unknown
endpoint, invalid root count, or limit violation is rejected before dry-run.

## 5. Deterministic dry-run

`WavePlanDagDryRunRequestV2` has exactly `kind`, `version`,
`manifestAlias`, `manifestDigest`, and `outcomes`. The first two values are
the exact kind and integer version. Both manifest binding values MUST equal
the validated manifest. `outcomes` has 0 through 32 unique closed entries,
each with exactly:

```json
{
  "kind": "WavePlanDagStageOutcomeV2",
  "version": 2,
  "stageId": "stg_00000000",
  "outcome": "gate_passed"
}
```

`outcome` is only `gate_passed` or `gate_failed`. Outcome array order is
irrelevant. An outcome for an unknown, duplicate, waiting, or nonselected
stage is malformed or an `outcome_join_mismatch`; no receipt is issued.

Dry-run is a pure, read-only function of the validated manifest and outcome
set. It visits stages in the canonical topological order:

1. The root is `ready/root_stage` until an admitted outcome makes it
   `terminal/gate_passed` or `terminal/gate_failed`.
2. An incoming edge is matching only when its source is terminal and its
   closed predicate matches. It is nonmatching when its source is terminal
   with the other outcome or is `not_selected`. Otherwise it is unresolved.
3. `any_matching` is `ready/any_matching_satisfied` as soon as at least one
   edge matches. With no match it is `waiting/join_unresolved` while any edge
   is unresolved, then `not_selected/no_matching_edge`.
4. `all_matching` waits as `waiting/join_unresolved` until every incoming
   edge is resolved. It is then `ready/all_matching_satisfied` only if every
   edge matches; any nonmatching edge makes it
   `not_selected/all_matching_unsatisfied`.
5. An admitted outcome changes only a currently ready stage to its terminal
   state. It never changes another stage directly.

A partial outcome snapshot is valid, but every missing fact stays unresolved.
Thus partial input fails closed to `waiting`, never to inferred readiness.
When all inbound edges resolve without satisfying the join policy, the join
fails closed to `not_selected`. Neither state authorizes action.

The receipt has exactly:

- `kind=WavePlanDagDryRunReceiptV2`, `version=2`;
- the exact `manifestAlias` and `manifestDigest`;
- `mode=read_only_rehearsal`;
- `topologicalOrder`, containing each bounded stage ID exactly once;
- `stages`, in that same order, with only closed `stageId`, `state`, and
  `reason` enums;
- the same fixed dispatch, operator, dry-run, and authority fields as the
  manifest;
- `receiptDigestDomain=a2a.wave-plan-dag-v2.dry-run-receipt.v2`; and
- the receipt digest from section 6.

The state enum is `ready`, `waiting`, `not_selected`, or `terminal`. The
reason enum is `root_stage`, `all_matching_satisfied`,
`any_matching_satisfied`, `join_unresolved`, `no_matching_edge`,
`all_matching_unsatisfied`, `gate_passed`, or `gate_failed`, with only the
combinations defined above. No prompt, payload, free-form outcome detail,
command, identity, or free-form reason is returned.

Malformed or partial facts never receive optimistic interpretation. Stable
rejection reasons are `manifest_malformed`, `duplicate_stage`,
`unknown_endpoint`, `duplicate_edge`, `self_edge`, `root_count_invalid`,
`unreachable_stage`, `cycle_detected`, `stage_limit_exceeded`,
`edge_limit_exceeded`, `depth_limit_exceeded`, `fan_in_limit_exceeded`,
`fan_out_limit_exceeded`, `manifest_digest_mismatch`,
`outcome_set_malformed`, `unknown_outcome`, and
`outcome_join_mismatch`. A rejection grants no authority and emits no
success-like receipt.

## 6. Canonical encoding and exact digests

Canonical JSON sorts object keys by ascending ASCII byte value, preserves
array order unless normalization is specified below, uses JSON string escaping
and UTF-8, uses minimal base-10 safe integers, and has no insignificant
whitespace. Values are printable ASCII strings, booleans, safe integers,
arrays, and objects only.

Before calculating `manifestDigest`, remove only `manifestDigest`, sort
`stages` by ASCII `stageId`, and sort `edges` by the ASCII tuple
`fromStageId`, `toStageId`, `when`. This makes the digest independent of input
array order while binding every declarative field and every reviewed stage
manifest digest.

Digest framing is the byte concatenation:

1. ASCII `A2A-WAVE-PLAN-DAG-V2` and one zero byte;
2. a 4-byte unsigned big-endian domain length;
3. the exact ASCII domain;
4. a 4-byte unsigned big-endian canonical-payload length; and
5. the canonical JSON payload bytes.

The result is lowercase SHA-256 with the `sha256:` prefix.

`receiptDigest` applies the same frame to the complete receipt excluding only
`receiptDigest`. It therefore binds the exact manifest digest, stable
topological order, stage states and reasons, rehearsal mode, and absence of
authority.

## 7. Fail-closed boundary

Digest mismatch, malformed or duplicate outcomes, an unknown outcome, or an
outcome that skips a waiting join rejects the rehearsal. Cycles and malformed
graphs cannot be rehearsed. No repair, inferred branch, default success,
implicit join satisfaction, dispatch, advance, claim, retry, finalization, or
live action is permitted.

The synthetic fixture and no-network checker pin a diamond
fan-out/`all_matching` join, conditional passed and failed branches,
`any_matching`, partial-outcome waiting, canonical ordering, exact digest
vectors, structural and limit rejection cases, private/code field rejection,
digest mismatch, and the no-authority model proposal boundary.
