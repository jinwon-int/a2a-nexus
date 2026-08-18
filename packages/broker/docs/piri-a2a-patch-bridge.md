# Host Piri patch bridge

`scripts/piri-a2a-patch-bridge.mjs` is the non-docker GitHub patch path (#1886).

| Lane | Binary / profile |
|---|---|
| Analysis | `piri-a2a-analysis-bridge.mjs` |
| Docker GitHub patch | `A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=piri` |
| Host GitHub patch | `OPENCLAW_BIN=.../piri-a2a-patch-bridge.mjs` |

Piri only edits files. The bridge owns `gh repo clone`, branch, commit, push, and `gh pr create`. Piri is instructed not to run those commands.

Worker env:

```
OPENCLAW_BIN=/opt/a2a-broker-worker/scripts/piri-a2a-patch-bridge.mjs
A2A_OPENCLAW_BRIDGE_ENABLED=1
A2A_PIRI_MODEL=kimi-coding/k3
A2A_PIRI_CONFIG_DIR=/var/lib/a2a-runner/piri-dir
A2A_PIRI_BIN=/opt/piri/piri-test.sh   # optional; defaults to piri-test.sh then `piri`
```

No live provider or GitHub calls in unit tests. Fleet deploy/restart is a separate operator step after merge.
