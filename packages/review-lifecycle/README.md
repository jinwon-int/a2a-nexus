# a2a-review-lifecycle

Bounded PR review lifecycle engine
([#1518](https://github.com/jinwon-int/a2a-nexus/issues/1518)), moved out of the
broker into its own workspace package by
[#2477](https://github.com/jinwon-int/a2a-nexus/issues/2477) under the
[spin-off decision record](../../docs/spin-off-extraction-decision-record.md) §3.
Code moved verbatim from `packages/broker/src/review-lifecycle/` (history kept
with `git mv`); the broker keeps the persistence and transport adapters and
imports this engine through the package root (`from "a2a-review-lifecycle"`).
The contracts are specified in
[`docs/specs/bounded-pr-review-lifecycle/`](../../docs/specs/bounded-pr-review-lifecycle/).

## What this package owns

- `types.ts`, `lifecycle.ts`, `read-model.ts` — record-mode lineage types
  (`a2a.review-lineage.v1`), budget/ledger transitions, and read projections.
- `canonical-json.ts` — sorted-keys canonical JSON plus `intentHash`,
  `diffHash`, and `findingSignature`. Its bytes are part of the wire contract
  (signed retrieval snapshots and stored lineages carry them); this is not the
  RFC 8785 canonicalizer in `a2a-attestation`.
- Source authorization and adapters: `authorized-source.ts`,
  `lineage-create-source.ts`, `operator-cancel-source.ts`,
  `correction-generation-source.ts`, `reviewer-replacement-source.ts`,
  `review-report-source.ts`, `lineage-source-adapter.ts`, `source-carrier.ts`,
  `producer-contract.ts`.
- `observation.ts`, `enforcement.ts`, `privacy-retention.ts`, `appeal.ts`,
  `patch-candidate.ts`, `simulation-fixture.ts` — observation records,
  enforcement decisions, retention/redaction, and fixture parsing.
- `scorecard.ts` and the offline `scorecard-cli.ts` (#1518 Phase 7).

The root export `"."` is a barrel over the 20 library modules. There is no
package `bin` (owner decision, decision record §6); the scorecard CLI runs from
the compiled output:

```bash
npm run build -w packages/review-lifecycle
node packages/review-lifecycle/dist/scorecard-cli.js \
  --input /path/to/redacted-lineages.json \
  --output /path/to/scorecard.json
```

`fixtures/review-lineage-scorecard/sample-input.json` is a synthetic example
of the redacted input envelope, not rollout evidence.

## Boundaries

- This package must not import broker internals. The broker depends on this
  package (exact pin `0.1.0`), never the reverse; the composite project has no
  reference back to the broker, so such an import fails to compile.
- Behavior-preserving move: no contract, schema id, persisted shape, HTTP
  route, or canonical-JSON byte changed. A breaking wire change adds a `.v2`
  id next to `.v1`; a `.v1` shape is never changed in place.
- `private: true`; the package version is not a compatibility signal and is
  not published.
- The conformance fixtures stay at the repository root in
  [`fixtures/review-lifecycle/`](../../fixtures/review-lifecycle/README.md);
  the package tests read them without modification.

## Local verification

From the repository root after installing dependencies. Tests use local
fixtures only and need no broker, network, or credentials.

```bash
npm run check -w packages/review-lifecycle
npm test -w packages/review-lifecycle
npm run coverage:baseline -w packages/review-lifecycle
```
