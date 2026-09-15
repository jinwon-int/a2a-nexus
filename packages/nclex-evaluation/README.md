# a2a-nclex-evaluation

NCLEX content PR evaluation domain, extracted from the broker core in the
first [#1601](https://github.com/jinwon-int/a2a-nexus/issues/1601) core-slimming
slice ([spec](../../docs/specs/core-slimdown-first-slice/spec.md)). Code moved
verbatim from `packages/broker/src/nclex-evaluation/`; the broker server keeps
the HTTP route delegation, startup keyring loading and snapshot integration.
Start with the [agent manual](../../docs/agent-manual.md), then the
[NCLEX evaluation contract](../../docs/nclex-content-pr-evaluation.md) for
routing requirements and executable local verification.

## What this package owns

- `receipt-contract.ts` — signed receipt contract (`nclex.content-pr.receipt.v1`),
  RFC 8785 JCS canonicalization via `a2a-attestation`, EdDSA verification,
  fail-closed validation (malformed cores, unknown key ids, invalid signatures,
  self-review rejected).
- `receipt-store.ts` — in-memory, receiptId-deduped store with snapshot
  restore support (persistence rides the broker's snapshot extension).
- `merge-ready.ts` — pure merge-ready projection (quorum 2 normal / 3
  high-risk, fresh exact-head signed PASS receipts only, blocking findings
  veto). This counts fresh PASS records; it does not independently establish
  distinct reviewer quorum or verify caller-supplied GitHub facts.
- `load-keyring.ts` — keyring file loading with the original error contract.

The offline signing tool that produces receipts is root-level
`scripts/nclex-content-pr-receipt.mjs`; it stays at the repository root.

## Boundaries

- This package must not import broker internals (enforced in review; the
  broker depends on this package, never the reverse).
- The package can be tested locally, but it also backs live broker routes.
  The broker registers those routes only when the option/environment keyring
  path resolves to a nonblank value (`A2A_NCLEX_EVALUATION_KEYRING_FILE`).
  Unreadable files or invalid loader structure fail startup; receipt submission
  performs signature verification. There is no separate NCLEX record/enforce flag.
- The projection does not call GitHub, approve or merge a PR. Source tests and
  historical submissions do not establish current fleet activation or acceptance.
- Keep operational key material out of documentation and logs.

## Local verification

From the repository root after installing dependencies; tests use local fixtures
and do not require an operational broker or operational keyring.

```bash
npm run check -w packages/nclex-evaluation
npm run test -w packages/nclex-evaluation
npm run coverage:baseline -w packages/nclex-evaluation
```
