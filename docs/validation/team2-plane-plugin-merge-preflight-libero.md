# Team2 plane/plugin merge-preflight libero

Parent: a2a-plane#249 (a2a-plane#249, internal tracker private)
Lane: Team2/soonwook merge-preflight
Snapshot: `2026-05-12T01:17:57Z`

This is a local-only merge-preflight artifact for the plane/plugin overlap in the config-schema skew prevention round. It does not deploy, restart Gateway/broker/worker services, send live provider or Telegram messages, mutate a database, ACK terminal evidence, change secrets, rewrite history, force-push, merge PRs, publish releases, or change repository visibility.

## Rechecked PRs

| Repo | PR | State at snapshot | Overlap notes |
| --- | --- | --- | --- |
| `a2a-plane (internal tracker, private)` | #255 (a2a-plane PR #255, internal tracker private) | open, CI green, mergeable | Touches `packages/openclaw-plugin-a2a/openclaw.plugin.json` and config-schema tests. |
| `a2a-plane (internal tracker, private)` | #254 (a2a-plane PR #254, internal tracker private) | open, CI green, mergeable | Touches the same plugin manifest/test fixture plus `package.json` release-gate wiring. |
| `a2a-plane (internal tracker, private)` | #253 (a2a-plane PR #253, internal tracker private) | open, CI green, mergeable | Touches `package.json` release-gate wiring for a sibling libero test. |
| `jinwon-int/openclaw-plugin-a2a` | [#271](https://github.com/jinwon-int/openclaw-plugin-a2a/pull/271) | open, CI green, mergeable | Plugin-side immediate schema fix; overlaps manifest schema with #273. |
| `jinwon-int/openclaw-plugin-a2a` | [#273](https://github.com/jinwon-int/openclaw-plugin-a2a/pull/273) | open, CI green, mergeable | Plugin-side schema hardening; overlaps manifest schema with #271. |

## Local preflight result

The intended handoff order was tested first:

```sh
npm run round:merge-preflight -- --run "npm run check && npm run test:release-gate" 255 254 253
```

Result: **NO-GO / Blocked**. PR #255 merged into the temporary worktree, PR #254 merged into that worktree, and PR #253 then conflicted in `package.json` before the integrated validation command could run.

The nearest alternate plane order was also tested:

```sh
npm run round:merge-preflight -- --run "npm run check && npm run test:release-gate" 255 253 254
```

Result: **NO-GO / Blocked**. PR #255 merged into the temporary worktree, PR #253 merged into that worktree, and PR #254 then conflicted in `package.json` before the integrated validation command could run.

## Blocker

`a2a-plane` PRs #253 and #254 both edit the same `package.json` `test:release-gate` line from the same base. Individual PR CI being green is not enough: the round cannot be merged cleanly until one branch is refreshed or a follow-up integration PR resolves the release-gate script line so both new tests are retained.

The plugin manifest/test overlap between plane #255/#254 merged cleanly in the local worktree. The remaining plane blocker observed here is the sibling `package.json` release-gate conflict.

## Cross-repo recommendation

1. Treat the plane train as **blocked** until `package.json` integrates both #253 and #254 release-gate test additions.
2. Keep the plugin train separate: run a local merge train in `jinwon-int/openclaw-plugin-a2a` for #271 then #273, because this plane checkout cannot prove plugin-repo merge behavior.
3. Merge or refresh plugin #271 before #273, then re-check plugin #273 against the updated plugin base.
4. After the plane `package.json` conflict is resolved, rerun the plane train with the exact intended order and require `npm run check && npm run test:release-gate` to pass before merging the first plane PR.

## Hygiene gate

Before any PR/terminal evidence is published for this lane, fail closed if branch changes or artifact evidence include OpenClaw runtime/bootstrap context paths: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.
