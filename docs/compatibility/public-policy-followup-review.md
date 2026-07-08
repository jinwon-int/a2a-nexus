# Public compatibility policy follow-up review

Issue: #94 (a2a-plane#94, internal tracker private)
Independent review lane: #166 (a2a-plane#166, internal tracker private)
Run: `a2a-public-readiness-next-20260509T165108Z`

This review is documentation and fixture evidence only. It does not deploy or restart services, contact a live broker, send provider messages, mutate a database, acknowledge terminal-outbox rows, change repository visibility, rotate secrets, or publish artifacts.

## Finding

The public compatibility policy can be reviewed from public-safe A2A Nexus files without relying on private broker-alpha-only assumptions. broker-alpha may appear as a source-broker example in a cross-broker fixture, but it is not required as broker of record, worker dispatcher, terminal-evidence authority, or visibility approver.

## Reproducible evidence

- `contracts/compatibility/matrix.md` bounds public compatibility claims to named candidate paths and baselines.
- `fixtures/contract/public-compatibility-policy.json` links #94 to this #166 review and records forbidden assumptions such as requiring broker-alpha as broker of record or treating provider message IDs as terminal ACK evidence.
- `fixtures/contract/broker-beta-cross-broker-handoff.json` keeps broker-beta as broker of record for Team2 and shows that the source broker does not dispatch destination workers.
- `test/conformance/check-contract-fixtures.mjs` validates both fixtures with no live provider send, terminal ACK mutation, private topology, or runtime/bootstrap evidence.

## Safe validation

```bash
node test/conformance/check-contract-fixtures.mjs
npm run scan:public-readiness
```

Expected result: both commands pass from the repository checkout using only tracked public-safe docs, examples, fixtures, and tests.

## Remaining gaps

This does not close the repository-level public visibility gates. External secret/history scanner evidence and explicit operator visibility approval remain separate requirements in `docs/history/public-readiness.md` and `docs/governance/public-private-boundary-gates.md`.
