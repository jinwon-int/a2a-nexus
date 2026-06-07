# Start — Wire `resolveTerminalBriefParentOriginRoute` into cross-broker Terminal Brief lifecycle

- **Issues:** https://github.com/jinwon-int/a2a-broker/issues/854, https://github.com/jinwon-int/a2a-broker/issues/856
- **Blocking PR:** https://github.com/jinwon-int/a2a-broker/pull/857
- **Focus:** Wire the pure routing helper (extended in PR #857) into the actual cross-broker Terminal Brief lifecycle: projection ingest validation, task creation metadata preservation, completion/outbox projection, notifier render with 2/2 parent counts, relay/mirror ownership, no ACK/replay/live-send conflation.
- **Environment:** Two-broker topology (seoseo=team1, gwakga=team2)

## Changed files
- `src/core/cross-broker-terminal-brief.ts` — Added `getParentRoundRouting` callback, `ParentRoundRoutingInfo` interface, routing validation in `ingest()`, `routing_mismatch` reject code
- `src/core/broker.ts` — Imported routing helper, wired `getParentRoundRouting` callback using `resolveTerminalBriefParentOriginRoute`
- `src/core/cross-broker-terminal-brief.test.ts` — 8 new routing integration tests including end-to-end broker A + broker B worker → 2/2 parent counts

## Verification
- `npx tsx --test src/core/cross-broker-terminal-brief.test.ts` — 36/36 pass (+8)
- `npx tsx --test src/core/broker.test.ts` — 108/108 pass
- `npx tsx --test src/core/terminal-brief-routing.test.ts` — 9/9 pass
