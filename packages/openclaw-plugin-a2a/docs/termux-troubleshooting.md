# Termux Troubleshooting Guide

Common issues when building and testing `plugin-a2a` on Android Termux.

## Build Issues

### `/usr/bin/env: bad interpreter`

**Symptom:** Running `npx tsc` or any `node_modules/.bin/*` shim fails with:
```
bash: ./node_modules/.bin/tsc: /usr/bin/env: bad interpreter: No such file or directory
```

**Cause:** Termux does not provide `/usr/bin/env`. All npm bin shims use `#!/usr/bin/env node` as their shebang.

**Fix:** Call TypeScript directly:
```bash
node ./node_modules/typescript/bin/tsc -p tsconfig.json
```

This is also why the `package.json` build script uses the direct path instead of `tsc`.

---

### `@lancedb/lancedb ... Unsupported platform: android`

**Symptom:** `npm install` fails with `EBADPLATFORM` for `@lancedb/lancedb`.

**Cause:** The `openclaw` peer dependency transitively depends on `@lancedb/lancedb`, which doesn't publish an Android binary. When npm tries to resolve the peer from the local tree, it hits this platform check.

**Fix:** Install with legacy peer deps, then symlink the global openclaw:
```bash
npm install --legacy-peer-deps
ln -sfn "$(npm root -g)/openclaw" node_modules/openclaw
```

The `--legacy-peer-deps` flag skips the strict peer resolution, and the symlink gives the plugin access to the already-installed global openclaw (which has the Android workaround already applied).

---

### TypeScript errors about missing `openclaw` types

**Symptom:** Build fails with:
```
error TS2307: Cannot find module 'openclaw/plugin-sdk/plugin-entry' or its corresponding type declarations.
```

**Cause:** The openclaw symlink is missing or broken.

**Fix:**
```bash
# Verify symlink
ls -la node_modules/openclaw

# Re-create if needed
ln -sfn "$(npm root -g)/openclaw" node_modules/openclaw

# Verify it resolves
node -e "require('openclaw/plugin-sdk/plugin-entry')"
```

---

## Runtime Issues

### Broker connection refused

**Symptom:** Plugin can't reach the broker at the configured URL.

**Diagnosis:**
1. Check if broker is running:
   ```bash
   curl http://localhost:8787/health
   ```
2. Check if `A2A_BROKER_URL` is set correctly in the OpenClaw config or environment.
3. On Termux, if broker runs on a host via Tailscale, use the Tailscale IP (100.x.x.x), not the public IP.

**Fix:**
```bash
# Start broker locally for testing
cd ../a2a-broker && PUBLIC_BASE_URL=http://localhost:8787 node dist/server.js

# Or point to remote broker via environment
export A2A_BROKER_URL=http://100.x.x.x:8787
```

---

### Rate limiting during testing

**Symptom:** `429 Too Many Requests` during rapid test iterations.

**Cause:** Default rate limit is 10 requests per 60 seconds per requester ID.

**Fix for testing:**
```bash
# Increase rate limits on the broker
RATE_LIMIT_MAX_REQUESTS=100 RATE_LIMIT_WINDOW_SEC=10 node dist/server.js
```

Or use different requester IDs for different test workers.

---

### Edge secret authentication failure

**Symptom:** `401 Unauthorized` on all non-health routes.

**Cause:** `EDGE_SECRET` is set on the broker, but the plugin doesn't have the matching secret configured.

**Fix:**
```bash
# Ensure the same secret is set on both sides without pasting the value into docs.
# Broker side:
EDGE_SECRET="${A2A_EDGE_SECRET}" node dist/server.js

# Plugin side (OpenClaw config or env):
export A2A_BROKER_EDGE_SECRET="${A2A_EDGE_SECRET}"
# or
export BROKER_EDGE_SECRET="${A2A_EDGE_SECRET}"
# or
export EDGE_SECRET="${A2A_EDGE_SECRET}"
```

The plugin resolves secrets in this order: `BROKER_EDGE_SECRET` → `A2A_BROKER_EDGE_SECRET` → `EDGE_SECRET` → `A2A_EDGE_SECRET`.

---

## Pass/Fail Signals

### Delegated Task Round Trip — Success Signals

1. `a2a.task.request` returns `status: "queued"` with a task ID
2. Broker shows the task under `GET /tasks`
3. Worker claims and starts the task
4. Plugin receives `a2a.task.update` with `status: "running"`
5. Worker completes the task
6. Plugin receives `a2a.task.update` with `status: "succeeded"` and `result` populated
7. Audit trail shows: `task.created` → `task.claimed` → `task.started` → `task.succeeded`

### Delegated Task Round Trip — Failure Signals

- `status: "failed"` with `error.code` populated
- `status: "canceled"` if the task was explicitly canceled
- If the task stays `queued` or `claimed` for longer than `STALE_REAPER_OLDER_THAN_SEC`, the broker reaper will requeue or dead-letter it
- Check broker audit with `GET /audit?targetId=<taskId>` for the full lifecycle

---

## Termux-Specific Notes

### Tailscale Networking
- Termux runs the Tailscale userspace networking stack
- Broker connections over Tailscale use `100.x.x.x` addresses
- DERP relay adds ~20-50ms latency; direct connections are faster
- Background process may lose network when Android kills the app; Tailscale reconnects automatically but TCP connections drop

### Background Process Management
- Use `tmux` to keep long-running broker connections alive
- Android battery optimization may kill Termux background processes
- Consider `termux-wake-lock` to prevent CPU sleep during tests

### File System
- Termux storage is under `/data/data/com.termux/files/`
- No FUSE by default; `node_modules/.cache` may behave differently
- Symlinks work normally within the Termux filesystem
