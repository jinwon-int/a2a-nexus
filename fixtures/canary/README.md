# Rollout canary fixtures (#1291 R6)

The rollout canary payloads used to live only in the operator skill; committing
them here makes the canary **definitions** code-review subjects. Each fixture
is a replay bundle (`{ task, payload }`) plus an `expectedVerdict` block
declaring the gate outcome the canary is supposed to produce.

| Fixture | Intent | Expected verdict |
|---|---|---|
| `empty-source-bundle.json` | fail-closed control: empty `sourceBundle` | readiness `fail` (`source_projection_empty`), bridge `zero_files` |
| `normal-source-bundle.json` | healthy control | readiness `pass`, 2 files, bridge `complete` |
| `source-files-only.json` | `sourceFiles[]` carrier coverage (the PR #1271 parallel-copy drift class) | readiness `pass`, 2 files, bridge `complete` |
| `large-manifest-two-carriers.json` | release-blocker shape: 2 carriers × 8 items (prompt-excerpt truncation / zero_files class) | readiness `pass`, **16** files, bridge `complete` |

Validate locally (no broker, no workers, no model calls) through the round
replay harness (#1302):

```
node packages/broker/scripts/replay-round.mjs --payload fixtures/canary/<fixture>.json --json
```

`packages/broker/scripts/canary-fixtures.test.mjs` pins every fixture to its
`expectedVerdict` in CI, so editing a canary without updating its declared
verdict fails the suite. All content is synthetic — no operational payloads,
worker names, or node ids may appear here (also test-enforced).

Operator rollout skills should reference these files instead of carrying
private copies; a canary change lands as a reviewed PR to this directory.
