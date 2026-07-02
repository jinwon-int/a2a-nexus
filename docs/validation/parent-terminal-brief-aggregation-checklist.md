# Parent Terminal Brief aggregation checklist

Issue: a2a-plane#269 (a2a-plane#269, internal tracker private)
Contract: `contracts/a2a/parent-terminal-brief-aggregation.md`
Fixture: `fixtures/contract/parent-terminal-brief-aggregation.json`
Canary: brokerBeta-origin parent round with brokerAlpha handoff child task

This checklist is for PR/Done/Block evidence on parent-broker Terminal Brief aggregation work. It is intentionally no-live: it does not deploy or restart services, send provider messages, mutate production databases, mutate terminal-outbox ACK rows, merge PRs, publish releases, or change repository visibility.

## Required evidence before closeout

- [ ] Start marker exists for the lane.
- [ ] Terminal PR, Done, or Block marker links the produced artifact.
- [ ] Closeout cites the contract path and fixture path.
- [ ] Closeout includes local conformance command output.
- [ ] Closeout records the synthetic `parentRoundId` and `originBrokerId`.
- [ ] Closeout records the `projectionKey` used for replay/no-replay proof.
- [ ] Closeout states that the projection is redacted and bounded.
- [ ] Closeout states that no live provider send, production DB mutation, terminal-outbox ACK mutation, restart, visibility change, force-push, release, or automatic merge occurred.
- [ ] Closeout confirms runtime/bootstrap hygiene before PR/artifact publication and reports exact offending repo-relative paths if the guard fails.

## Metadata lifecycle checks

- [ ] `originBrokerId` is minted by brokerBeta with the parent round.
- [ ] `parentRoundId` remains stable across every child projection in the round.
- [ ] brokerAlpha handoff receives `parentRoundId` and `originBrokerId` as copied metadata, not as authority to rewrite them.
- [ ] Child broker of record appends child task/evidence fields only after it owns the child task.
- [ ] Parent aggregation reads terminal child evidence but does not mutate child lifecycle, worker assignment, provider-send records, or ACK state.

## Projection field checks

The parent projection must include:

- [ ] `projectionKey`
- [ ] `parentRoundId`
- [ ] `originBrokerId`
- [ ] `parentBrokerId`
- [ ] `handoffBrokerId`
- [ ] `childBrokerId`
- [ ] `childTaskId`
- [ ] `childIssueUrl`
- [ ] `terminalKind`
- [ ] `terminalEvidenceUrl`
- [ ] `terminalSummary`
- [ ] `projectionState`
- [ ] `redacted`
- [ ] `projectedAt`
- [ ] `terminalOutboxAckMutated: false`
- [ ] `liveProviderSend: false`
- [ ] `isApproval: false`
- [ ] `isTerminalAck: false`
- [ ] `isReadReceipt: false`

## Redaction boundary checks

- [ ] Bounded summaries only; no full transcript or child worker log projection.
- [ ] No secrets, token-like strings, private endpoint values, private host paths, or provider payloads.
- [ ] Unsafe child evidence becomes a redacted `block` projection rather than copied evidence.
- [ ] GitHub issue/PR URLs are evidence ledger links only; they are not approval, read receipt, or terminal ACK.

## Rollback/no-replay checks

- [ ] Duplicate projection with the same `projectionKey` returns the existing projection and sets `newProjectionCreated: false`.
- [ ] Same-key/different-payload input becomes `conflict` and fails closed.
- [ ] Rollback is metadata-only: mark projection `blocked` or `conflict`, preserve the key, and add a redacted reason.
- [ ] Parent aggregation failure does not rerun the child task or create live side effects.

## Local validation commands

```bash
node test/conformance/check-contract-fixtures.mjs
npm run test:conformance
```
