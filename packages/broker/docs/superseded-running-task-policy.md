# Superseded running task policy

When an A2A round finalizer selects a winning PR or Done/Block evidence, slower sibling lanes can still be `claimed` or `running`. Those lanes should not keep consuming worker capacity or produce late merge candidates against an already-finalized issue.

## Finalizer rule

After the winning evidence is accepted, a hub/operator may cancel non-terminal sibling tasks as superseded by calling the existing task cancel API with structured supersede fields:

```json
{
  "actor": { "id": "brokeralpha", "kind": "node", "role": "hub" },
  "reason": "finalizer selected and merged PR #356",
  "supersededByTaskId": "round-selected-pr",
  "supersededByPrUrl": "https://github.com/jinwon-int/a2a-docker-runner/pull/356",
  "roundId": "a2a-team1-354-runner-nochange-contract-20260606T145219KST"
}
```

The broker records `task.cancellation.kind="superseded"` plus the `supersededBy...` fields, writes the normal canceled tombstone, and projects diagnostics with `interruption.kind="superseded"`.

## Safety boundaries

- Only hub/operator/requester/assigned-worker cancellation authority can use this path.
- If `supersededByTaskId` is supplied, it must refer to a different terminal task known to the broker.
- Late worker evidence after cancellation is preserved as late evidence; it does not reopen the task or replace the finalizer decision.
- This is a broker API/source policy. It does not perform DB surgery, Terminal ACK/replay, provider sends, or deployment by itself.

## Late PR handling

Late PRs produced by superseded lanes should be reviewed as evidence. Merge them only if they are materially better than the already-selected fix; otherwise close them as superseded and link the selected PR/task.
