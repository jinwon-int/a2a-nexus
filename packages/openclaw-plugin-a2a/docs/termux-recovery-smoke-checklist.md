# Termux / Mobile Recovery Smoke Checklist

> **Issue:** jinwon-int/plugin-a2a#77
> **Node:** mobileAlpha (Android Termux)
> **Purpose:** Validate that recovery loop hardening works correctly on low-resource mobile nodes.

---

## Prerequisites

- [ ] OpenClaw gateway running on Termux
- [ ] `plugin-a2a` built (`npx tsc`)
- [ ] Broker reachable from Termux (Tailscale or direct)

## Build & Install

```bash
cd plugin-a2a
npx tsc
# Verify dist/src/recovery-guard.js exists
ls -la dist/src/recovery-guard.js
```

## T1. Recovery Guard Unit Tests

```bash
node --test test/recovery-guard.test.mjs
```

**Expected:** All T1–T10 tests pass.

## T2. Duplicate Wake Suppression

1. Trigger a recovery action (e.g., cancel a task) via broker API
2. Immediately trigger the same action again
3. Verify the second call returns `{ dedup: true }`
4. Check `guard.status().totalDeduplicated >= 1`

## T3. Concurrency Limit

1. With `maxConcurrent: 2`, start 2 recovery actions
2. Trigger a 3rd action
3. Verify it returns `{ allowed: false, reason: "Max concurrent..." }`
4. Complete one action, trigger the 3rd again
5. Verify it now returns `{ allowed: true }`

## T4. Retry Backoff

1. Force a recovery action to fail
2. Immediately re-evaluate — should be blocked by backoff
3. Wait for backoff to elapse (check `nextRetryDelayMs`)
4. Re-evaluate — should now be allowed

## T5. Network Reconnect Scenario

1. Start a recovery action
2. Kill Tailscale connection (`tailscale down`)
3. Wait 10 seconds, reconnect (`tailscale up`)
4. Trigger the same recovery action
5. Verify dedup — no duplicate destructive action created

## T6. Action Timeout

1. Start a recovery action
2. Do not complete it
3. Wait past `actionTimeoutMs` (default 60s)
4. Call `guard.status()` — verify `totalTimedOut >= 1`
5. Verify new actions can proceed (abandoned slot freed)

## T7. Memory Check (Termux-specific)

```bash
# Before running recovery loop
free -m | head -2

# Run recovery guard under load
node -e "
const g = require('./dist/src/recovery-guard.js').createRecoveryGuard();
for (let i = 0; i < 1000; i++) g.evaluate({ actionId: 'mem-' + i, kind: 'status_check', taskId: 'task-1' });
console.log(g.status());
"

# After
free -m | head -2
```

**Expected:** No significant memory growth (< 5 MB for 1000 records).

## T8. Mobile Profile Detection

```bash
node -e "
const g = require('./dist/src/recovery-guard.js').createRecoveryGuard();
console.log(JSON.stringify(g.status().nodeProfile, null, 2));
console.log(JSON.stringify(g.status().retryPolicy, null, 2));
"
```

**Expected on Termux:** `isMobile: true`, `maxAttempts: 2`, `baseDelayMs: 2000`

## T9. Integration with Wake Layer

```bash
# Run wake-layer + recovery-guard integration test
node --test test/recovery-loop.test.mjs
```

**Expected:** All R2–R8 tests pass.

## T10. Broker Command Center Status

1. Run recovery actions
2. Call `guard.status()`
3. Verify all fields are populated correctly:
   - `activeCount`, `pendingCount`, `totalAttempted`
   - `totalDeduplicated`, `totalRateLimited`, `totalTimedOut`
   - `nodeProfile.isMobile`

---

## Non-Mobile Compatibility

All guard behavior must remain compatible with standard Linux nodes:
- [ ] `isMobile: false` → standard retry policy (maxAttempts: 5)
- [ ] Same API surface, no platform-specific code paths in callers
- [ ] Tests pass on both mobile and non-mobile profiles

## Sign-off

- [ ] All tests pass
- [ ] No memory leaks on Termux
- [ ] Broker command center can display status
- [ ] PR ready for review
