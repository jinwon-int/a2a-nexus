# a2a-nclex-evaluation

NCLEX content PR evaluation domain, extracted from the broker core in the
first [#1601](https://github.com/jinwon-int/a2a-nexus/issues/1601) core-slimming
slice (spec: `docs/specs/core-slimdown-first-slice/spec.md`). Code moved
verbatim from `packages/broker/src/nclex-evaluation/`; the broker server keeps
only the HTTP route delegation seam.

## What this package owns

- `receipt-contract.ts` — signed receipt contract (`nclex.content-pr.receipt.v1`),
  RFC 8785 JCS canonicalization via `a2a-attestation`, EdDSA verification,
  fail-closed validation (malformed cores, unknown key ids, invalid signatures,
  self-review rejected).
- `receipt-store.ts` — in-memory, receiptId-deduped store with snapshot
  restore support (persistence rides the broker's snapshot extension).
- `merge-ready.ts` — pure merge-ready projection (quorum 2 normal / 3
  high-risk, fresh exact-head signed PASS receipts only, blocking findings
  veto).
- `load-keyring.ts` — keyring file loading with the original error contract.

The offline signing tool that produces receipts is root-level
`scripts/nclex-content-pr-receipt.mjs`; it stays at the repository root.

## Boundaries

- This package must not import broker internals (enforced in review; the
  broker depends on this package, never the reverse).
- No keyring material is moved or logged by this code; only the file-path
  contract (`A2A_NCLEX_EVALUATION_KEYRING_FILE`) travels with it.

## Local verification

```bash
npm run check -w packages/nclex-evaluation
npm run test -w packages/nclex-evaluation
npm run coverage:baseline -w packages/nclex-evaluation
```
