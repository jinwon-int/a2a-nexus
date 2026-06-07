# E2E Wake-on-Task Proof Runbook

**Issue**: jinwon-int/openclaw-plugin-a2a#40
**Direction**: Node Hub (sender/driver) → Node Remote (receiver/audit)
**Nodes**: node-hub (host-hub) → node-remote (host-remote)

---

## A0 — Preparation Checklist

| # | Item | Status |
|---|------|--------|
| A0.1 | Node Remote `a2a.peer.status` gateway handler wired | ✅ PR #57 |
| A0.2 | Broker PeerStatus returns `observedAt` + `cacheAgeMs` timestamps | ✅ PR jinwon-int/a2a-broker#46 (merged) |
| A0.3 | Wake Layer default-off confirmed | ✅ `wake.enabled: false` by default |
| A0.4 | Both nodes running latest plugin build with PR #57 | ⏳ post-merge |
| A0.5 | Broker server running with PeerStatus support | ⏳ deployment |

## Timestamp Markers (T0–T3)

| Marker | Definition | Source |
|--------|-----------|--------|
| T0 | Task created at broker (epoch ms) | `brokerTask.createdAt` |
| T1 | Wake envelope accepted (epoch ms) | `wake.audit.atMs` |
| T2 | Target agent run started (epoch ms) | `runtimeRunId` creation timestamp |
| T3 | Peer status query confirms wake delivery (epoch ms) | `peerStatus.response.observedAt` |

**Success criteria**: T3 - T0 < 60,000ms (sub-minute wake)

## S1 — Cold Wake Smoke Test (1 trial)

### Setup
1. Ensure Wake Layer is **disabled** on both nodes (default)
2. Deploy plugin build with PR #57 on both nodes
3. Deploy broker build with PeerStatus on node-hub

### Execution (Node Hub drives)
1. Node Hub creates an A2A task targeting node-remote via `a2a.task.request`
2. Verify task is accepted (`status: queued`)
3. **Enable Wake Layer** on node-hub only (opt-in): `config.wake.enabled = true`
4. Create a second A2A task targeting node-remote
5. Record T0 from the task creation response
6. Wait for wake dispatch (should be sub-minute)
7. Query `a2a.peer.status` for node-remote to get T3
8. Record all timestamps

### Node Remote Audit Collection
```bash
# On node-remote: check gateway received the peer status query
journalctl -u openclaw -n 100 --no-pager | grep -i "peer.status\|PeerStatus"

# Check for wake delivery
journalctl -u openclaw -n 100 --no-pager | grep -i "wake\|a2a.wake"
```

### Pass Criteria
- [ ] T3 - T0 < 60,000ms
- [ ] No duplicate runs spawned
- [ ] Wake audit event logged

## S2 — Duplicate Prevention

1. Send two identical tasks (same target, same correlationId) rapidly
2. Verify only one wake dispatch occurs
3. Verify `duplicate_wake` skip code in audit

### Pass Criteria
- [ ] Second task shows `duplicate_wake` or `coalesced` status
- [ ] Only one agent run on target node

## S3 — Failure Fallback

1. Temporarily make node-remote unreachable (stop gateway)
2. Send A2A task from node-hub targeting node-remote
3. Wake should fail gracefully
4. Verify fallback heartbeat delivery still works

### Pass Criteria
- [ ] Wake fails with `wake_dispatch_failed` or `wake_rejected`
- [ ] Task remains in broker (not lost)
- [ ] Fallback heartbeat eventually delivers task

## S4 — Rate Limit Verification

1. Send 25+ rapid peer status queries for same target
2. Verify rate limiting kicks in
3. Verify `retryAfterMs` is returned

### Pass Criteria
- [ ] Rate limited after ~25 requests
- [ ] Response includes `retryAfterMs > 0`

## S5 — Multi-Trial (50 trials)

After S1–S4 pass:
1. Run 50 sequential wake cycles
2. Record T0–T3 for each
3. Calculate p50, p95, p99 latency
4. Verify all within 60s threshold

### Pass Criteria
- [ ] All 50 trials: T3 - T0 < 60,000ms
- [ ] p50 < 10,000ms
- [ ] p99 < 30,000ms
- [ ] Zero duplicate runs

---

## Wake Layer Safety

> ⚠️ Wake-on-Task remains **default-off / opt-in** until canary proof complete.
> 
> Only enable via explicit config: `plugins.entries.a2a-broker-adapter.config.wake.enabled = true`
> 
> No other code path should enable wake automatically.
