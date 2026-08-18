# Host Piri patch bridge

`scripts/piri-a2a-patch-bridge.mjs` is the non-docker GitHub patch path (#1886).

| Lane | Binary / profile |
|---|---|
| Analysis | `piri-a2a-analysis-bridge.mjs` |
| Docker GitHub patch | `A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=piri` |
| Host GitHub patch | `A2A_PIRI_BIN=.../piri-a2a-patch-bridge.mjs` |

Piri only edits files. The bridge owns `gh repo clone`, branch, commit, push, and `gh pr create`. Piri is instructed not to run those commands.

Worker env:

```
A2A_PIRI_BIN=/opt/a2a-broker-worker/scripts/piri-a2a-patch-bridge.mjs
A2A_PIRI_ANALYSIS_BIN=/opt/a2a-broker-worker/scripts/piri-a2a-analysis-bridge.mjs
A2A_PIRI_MODEL=kimi-coding/k3
A2A_PIRI_CONFIG_DIR=/var/lib/a2a-runner/piri-dir
A2A_PIRI_CLI=/opt/piri/piri-test.sh   # optional piri executable
```

`OPENCLAW_BIN` remains a legacy fallback for the host patch command. Do not point `A2A_PIRI_BIN` at the piri CLI itself.

No live provider or GitHub calls in unit tests. Fleet deploy/restart is a separate operator step after merge.
