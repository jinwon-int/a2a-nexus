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

### Analysis lane on Docker-less hosts (`A2A_PIRI_EXEC=native`, #1899)

The analysis bridge defaults to the docker lane above. Worker hosts without a
Docker runtime (Termux/Android mobile workers) set `A2A_PIRI_EXEC=native` to run
the host piri CLI directly — same schema contract, progress-file telemetry, and
piri #14 exit-code mapping, with the worker environment inherited verbatim so
piri reads its own credential store under `$HOME/.piri/agent/auth.json`:

```
A2A_PIRI_EXEC=native
A2A_PIRI_CLI=/data/.../piri/pi-test.sh     # host piri CLI (same precedence as the patch bridge)
A2A_PIRI_MODEL=zai/glm-5.3
A2A_PIRI_THINKING=high
A2A_PIRI_WORK_ROOT=$HOME/.a2a/piri-analysis-tasks   # optional; defaults to os.tmpdir()
A2A_PIRI_SCHEMA_PATH=...                          # optional; defaults to the repo contract schema
```

Preflight fail-closed mapping: invalid `A2A_PIRI_EXEC`, a missing schema, or a
prompt above the native per-argument argv budget exits as
`analysis_bridge_invocation_invalid` (handler_artifact_failure); a missing host
credential exits as `analysis_bridge_credential_unavailable`. Docker lanes are
unaffected when `A2A_PIRI_EXEC` is unset or `docker`.

No live provider or GitHub calls in unit tests. Fleet deploy/restart is a separate operator step after merge.
