# Scheduling Diagnostics Runbook (issue #1032)

Interpreting the `/schedz` endpoint for periodic stall attribution.

## Quick Reference

| Field | What It Measures | Indicates Stall? |
|---|---|---|
| `schedulingTiming.p99Ms` | Handler-start to `res.finish` (all endpoints) | Maybe — correlated with low `flushing.handlerToFinishGapMs` it points to handler/work scheduling |
| `endpointTiming.<group>.p99Ms` | Handler-start to `res.finish` by endpoint group | Yes — isolates whether the tail is `/livez`, `/health`, A2A task APIs, workers, or other routes |
| `endpointActive.<group>` | Current in-flight requests by endpoint group | Correlate — non-zero buildup points to route-specific queue pressure |
| `connections.connectionDurationMs.p99Ms` | Socket open to close duration | Unlikely directly; correlated with `perRequest.firstRequestLatencyMs` when high |
| `connections.httpServer.*` | Node HTTP server timeout and per-socket limits | Context — compare reused idle tails against `keepAliveTimeout`, `headersTimeout`, and `maxRequestsPerSocket` |
| `perRequest.firstRequestLatencyMs.p99Ms` | Time from TCP accept to first request handler start | **Yes** — high values suggest host/process scheduling delay before the handler even runs |
| `perRequest.socketAcceptedToHttpRequestEventMs.p99Ms` | TCP accept to Node HTTP `request` event | Yes — separates accepted-socket idle/parser time from handler dispatch |
| `perRequest.httpRequestEventToHandlerStartMs.p99Ms` | Node HTTP `request` event to broker handler entry | Yes — should stay near zero; high values point to listener dispatch/pre-handler pressure |
| `perRequest.socketIdleBeforeHttpRequestEventMs.p99Ms` | Previous response finish to next Node HTTP `request` event on reused socket | Correlate — reused socket idle before parser/request dispatch |
| `perRequest.clientProbeStartToHttpRequestEventMs.p99Ms` | Client probe start to Node HTTP `request` event | **Yes** — high value while socket idle is low indicates client pool artifact, not server-side delay |
| `perRequest.byConnectionReuse.fresh.socketAgeBeforeHandlerMs.p99Ms` | Fresh-connection socket age before handler start (isolated from reused) | Yes — high values on fresh connections specifically suggest accept/scheduling pressure |
| `perRequest.byConnectionReuse.reused.socketIdleBeforeHttpRequestEventMs.p99Ms` | Reused-socket idle before HTTP request event (isolated from fresh) | **Yes** — directly measures reused-socket wire idle, not conflated with fresh-connection scheduling |
| `perRequest.byConnectionReuse.reused.idleBeforeDataMs.p99Ms` | Previous response finish to next request's first TCP data byte on reused socket | **Split** — separates pure wire idle (client hadn't sent yet) from data-arrived-but-not-processed |
| `perRequest.byConnectionReuse.reused.dataToHttpRequestEventMs.p99Ms` | First TCP data byte to HTTP `request` event on reused socket | **Yes** — high while idleBeforeData is low means data arrived but Node event-loop was blocked (GC, cgroup throttle, callback pressure) before HTTP parser fired |
| `operatorGate.bucket` | Pre-classified stall type: `reused-socket-idle-before-request-event`, `reused-socket-data-received-blocked`, `client-pool-artifact`, `node-request-event-delivery`, `accepted-socket-waiting-before-handler`, or `no-significant-stall` | Gate — Team1/Team2 hypothesis classifier for operator triage |
| `operatorGate.evidence` | Key p99 evidence values supporting the classification | Read-only — used to confirm or override the gate verdict |
| `perRequest.handlerMs.p99Ms` | Handler body execution (start → `res.end()`), excludes response flushing | Maybe — high while `firstRequestLatencyMs` is low indicates handler-side work (SQLite, serialization). Correlate with `schedulingTiming` and `handlerToFinishGapMs` to decompose total wall time. |
| `flushing.handlerToFinishGapMs.p99Ms` | `res.end()` call to `res.finish` event | **Yes** — high values suggest Node.js/TCP flush pressure after handler completes |
| `probeBursts` | Peer-sources hitting `/livez` >5 times in 10s | Artifact check — bursts from probe tools can distort `schedulingTiming` |
| `host.loadPerCpu` | System load per CPU core | Correlate — high load (>2.0) before stall suggests host scheduling |
| Connection reuse ratio | `onNewConnection / (onNewConnection + onReusedConnection)` | Frequent new connections suggest no keep-alive; adds TCP handshake + slow-start latency |

## `/livez` Attribution Buckets

`scripts/broker-comprehensive-diagnostics.mjs` emits `livezAttribution` in JSON
and a **Likely /livez Attribution** section in Markdown. Treat it as an
operator hint, not a root-cause verdict. The bucket is derived only from
bounded `/livez.probeTiming`, `/schedz.perRequest`, route timing, and heartbeat
phase summaries.

The same report also emits `livezSpikeCorrelation`, which summarizes only
`/livez` samples over the 1s threshold. Use that field to see whether slow
samples were first requests on a socket, reused keep-alive requests, or missing
socket metadata. The top slow sample list is redacted to timing fields only.

| Bucket | What It Means | Next Read-Only Evidence |
|---|---|---|
| `no-significant-stall` | No `/livez` sample crossed the 1s residual-stall threshold. | Keep the gate result as passing evidence. |
| `broker-handler-or-event-loop` | `/livez` handler timing or event-loop delay itself crossed the threshold. | Check `/livez.timing`, `/livez.eventLoop`, CPU, GC, and route-level `/schedz` timing. |
| `reused-socket-idle-before-request-event` | A reused socket was open and idle, but Node emitted the next HTTP `request` event late while handler entry stayed near-zero after the event. | Compare `socketIdleBeforeHttpRequestEvent`, `socketAcceptedToHttpRequestEvent`, and `httpRequestEventToHandlerStart`; then check keep-alive reuse, client/runtime pooling behavior, and socket lifecycle pressure. Check `idleBeforeDataMs` vs `dataToHttpRequestEventMs` to confirm data was not yet received from client. |
| `reused-socket-data-received-blocked` | A reused keep-alive socket received the TCP data bytes (low `idleBeforeDataMs`) but Node's event loop was blocked before the HTTP parser could fire the `request` event (high `dataToHttpRequestEventMs`). | **Not a broker-code issue.** Check Node event-loop pressure, cgroup CPU throttling (`container.cgroup.cpuDelta.nrThrottled`), GC pauses (`/livez.gc`), or host load. The HTTP parser couldn't run because Node was descheduled or busy. |
| `accepted-socket-waiting-before-handler` | The broker accepted the socket, but the request handler started late. | Check host scheduling, cgroup throttling, and concurrent route pressure. |
| `accepted-socket-waiting-for-data` | Fresh socket accepted but first TCP data byte delayed (socketConnectedToFirstDataMs dominates firstDataToHttpRequestEventMs). | Check client/Gwakga send timing, network latency, or host scheduling before read callback. |
| `accepted-socket-data-received-blocked` | First data byte arrived promptly but HTTP request event delayed (firstDataToHttpRequestEventMs dominates). Node event-loop was blocked (GC, cgroup throttle, callback pressure) after data arrived. | Check Node event-loop pressure, cgroup CPU throttling (`container.cgroup.cpuDelta.nrThrottled`), GC pauses, or host load. Not a broker-code issue. |
| `tcp-connect-or-accept-before-handler` | Client probe start to socket acceptance crossed the threshold. | Check TCP accept backlog, container scheduling before accept, and host pressure. |
| `response-egress-or-client-read` | Broker prepared the response before the client observed headers. | Check response flushing, kernel TCP buffer pressure, proxy/backpressure, and client-side timing. |
| `broker-scheduling-or-competing-route` | `/schedz` route/heartbeat timing crossed the threshold while `/livez` handler timing stayed low. | Inspect `requestRouteSummary`, `workerHeartbeatPhaseSummary`, and active route counts. |
| `external-client-wall-before-headers` | External fetch-to-headers was high, but deeper broker buckets did not identify a dominant lane. | Collect a longer approved gate or compare fresh vs reused connections. |
| `unattributed-external-wall` | A wall-time spike crossed threshold but no diagnostic field explained it. | Keep #1032 open and collect another approved evidence round. |

The classifier deliberately does not relax the #1032 acceptance criterion by
itself. A human operator still decides whether `/livez >1s=0` is required or
whether the criterion should be revised after enough attribution evidence.

When the operator's goal is strict wall-clock `/livez >1s=0`, use the
connection-mode comparison report's `livezSocketReusePolicy`. If fresh-socket
and standalone `/livez-only` probes are clean, but reused-socket modes still
show `reused-socket-idle-before-request-event`, the policy is to observe the
reused-socket residual as client/probe latency rather than classify it as a
broker handler, SQLite, heartbeat, or readiness failure. See
[`docs/socket-reuse-probe-policy.md`](socket-reuse-probe-policy.md).

## Diagnosis Flow

### 1. Check if the stall is real (not a probe artifact)

```
/schedz → probeBursts[]
```

If the stall correlates with probe bursts from the same `/24` prefix, the measured
latency may be a client-side artifact (curl timeout, Nagle, keep-alive race).
Increase `PROBE_BURST_THRESHOLD` or widen `PROBE_WINDOW_MS` in `server.ts` if needed.

### 2. Check if the stall is in accept/scheduling (before handler)

```
/schedz → perRequest.firstRequestLatencyMs.p99Ms
```

High first-request latency (e.g. >1000ms) while `schedulingTiming.p99Ms` is low
points to **accept/scheduling delay** — the process isn't getting CPU time or
the kernel TCP accept backlog is saturated.

**Causes:**
- Host CPU starvation (co-tenancy, noisy neighbors)
- Process descheduled by kernel (look at `/proc/pressure/cpu`)
- TCP SYN backlog overflow (`netstat -s | grep -i drop`)
- CGROUP CPU throttle (`/sys/fs/cgroup/cpu.stat`)

### 3. Check if the stall is in handler processing

```
/schedz → schedulingTiming.p99Ms
/schedz → perRequest.handlerMs.p99Ms
```

High handler timing with low first-request latency means the handler itself is slow.
Use `handlerMs` to isolate the handler body execution time from response flushing:

```
  handlerMs ≈ schedulingTiming - handlerToFinishGapMs
```

If `handlerMs` dominates `schedulingTiming`, the cause is handler-side work.
If `handlerToFinishGapMs` dominates, the cause is TCP/flush backpressure.

**Causes:**
- SQLite contention (hot-table reads block on writes)
- Task broker loop processing
- Large JSON serialization (worker registration with many capabilities)
- GC pauses (check `/livez → gc.recentMax60sMs`)

### 4. Check if the stall is in response flushing

```
/schedz → flushing.handlerToFinishGapMs.p99Ms
```

High flush gap after `res.end()` called but before `res.finish` fires means
Node.js or the kernel is buffering the response.

**Causes:**
- Nagle's algorithm interaction with TCP_CORK/NODELAY on keep-alive sockets
- Kernel TCP buffer pressure (`netstat -an | grep -c TIME_WAIT`)
- Connection count peaking (check `/schedz → connections.peakConnections`)
- Downstream proxy (Caddy/nginx) backpressure

### 5a. Check per-reused-request first-data-byte breakdown (#1032 antithesis-runtime)

```
/schedz → perRequest.byConnectionReuse.reused.idleBeforeDataMs
               .dataToHttpRequestEventMs
```

For reused keep-alive sockets, `socketIdleBeforeHttpRequestEventMs` combines
two fundamentally different causes:

1. **Wire idle (`idleBeforeDataMs`):** the client hadn't yet sent the next
   request on the keep-alive connection. This is normal for intermittent
   health-check probes and is NOT a server-side issue.

2. **Event-loop blocked (`dataToHttpRequestEventMs`):** the TCP data bytes
   arrived at the server (`idleBeforeDataMs` is low), but Node's event loop
   couldn't process them — the HTTP parser didn't fire the `request` event
   until later. This means Node was either:
   - Descheduled by the kernel/cgroup (CPU throttling)
   - Blocked in a GC pause
   - Processing other callbacks (event-loop pressure)

**How to interpret:**

| Pattern | Meaning | Next Check |
|---|---|---|
| High `idleBeforeDataMs` (dominates `socketIdleBeforeHttpRequestEventMs`) | Client waited before sending request | Client pool behavior, keep-alive timeout race |
| High `dataToHttpRequestEventMs` (>500ms), low `idleBeforeDataMs` | Data arrived but Node couldn't process it | cgroup CPU throttle (`nrThrottled`), GC pause (`/livez.gc`), host load, PSI pressure |
| Both high | Compound: wire idle + event-loop pressure | Check all of the above |
| Both low | Request latency is in handler time or flushing | Check `schedulingTiming`, `handlerToFinishGapMs` |

This breakdown was added by the antithesis-runtime (jingun) to reject the
hypothesis that broker-code changes alone can fix reused-socket stalls.
The existing deploy/gate comment at `091b2ae` already attributes stalls to
`reused-socket-idle-before-request-event` — this refinement determines WHY.

### 5b. Check connection reuse

Compare `onNewConnection` vs `onReusedConnection`.

If >50% of requests arrive on new connections, keep-alive is not working
effectively. Each new connection adds:
- TCP handshake RTT (~TCP handshake)
- TLS negotiation (if HTTPS)
- Slow-start ramp
- **First-request scheduling delay** (the gap between socket creation and
  first HTTP request parsing — this is the hidden stall contributor)

If many requests arrive on reused connections but first-request latency is
still high, the server may be hitting `server.maxConnections` or socket
timeout (`server.timeout` / `keepAliveTimeout`).

`/schedz.connections.httpServer` exposes the active Node HTTP server connection
settings without changing runtime behavior:

- `keepAliveTimeoutMs`
- `headersTimeoutMs`
- `requestTimeoutMs`
- `timeoutMs`
- `maxRequestsPerSocket`
- `maxConnections`
- `connectionsCheckingIntervalMs`

## `/schedz` Operator Gate (Team1/Sogyo, #1032 round a2ad-1032-reused-socket-v2)

The `/schedz` endpoint now includes an `operatorGate` field that pre-classifies
the stall type from aggregate timing evidence. The gate classifier (Team1/Sogyo)
uses the following decision logic:

| Evidence Pattern | Gate Verdict | Operator Action |
|---|---|---|
| `reusedSocketIdleP99Ms > 1000ms` AND `reusedDataToReqEventP99Ms <= 500ms` (or first-data breakdown unavailable) | `reused-socket-idle-before-request-event` | Compare with `byConnectionReuse.reused.socketIdleBeforeHttpRequestEventMs` → check keep-alive timeout, client pool behavior |
| `reusedSocketIdleP99Ms > 1000ms` AND `reusedDataToReqEventP99Ms > 500ms` AND `reusedDataToReqEventP99Ms > reusedIdleBeforeDataP99Ms * 0.5` | `reused-socket-data-received-blocked` | Data arrived on socket but Node event-loop was blocked (GC, cgroup CPU throttle, event-loop pressure). Check `container.cgroup.cpuDelta`, `/livez.gc`, `host.loadPerCpu`. **Not a broker-code fix.** |
| `eventToHandlerP99Ms > 100ms` (handler entry delayed after request event) | `node-request-event-delivery` | Check Node event-loop pressure, listener dispatch hierarchy, pre-handler middleware stack |
| `clientProbeToReqP99Ms > 1000ms` AND `globalSocketIdleP99Ms < 500ms` (client sees delay, server not idle) | `client-pool-artifact` | Investigate client connection pooling, DNS resolution, or network path — not a server code issue |
| `freshSocketAgeP99Ms > 1000ms` (fresh connection slow) | `accepted-socket-waiting-before-handler` | Check host scheduling, cgroup CPU throttle, kernel accept backlog |
| None of the above | `no-significant-stall` | Continue monitoring; no evidence of reused-socket idle stall |

**Sogyo attribution:** The gate classifier (`computeReusedSocketGate` in
`server.ts`, sogyo team) cites the team name in every `reasons[]` entry so
that operator logs are traceable back to the hypothesis author.

**Distinguishing the three sources:**

1. **Server handler time** — already captured by `schedulingTiming.p99Ms` and
   `endpointTiming.*.p99Ms`. The gate does not re-classify handler time.
2. **Client pool artifact** — `clientProbeStartToHttpRequestEventMs` bridges
   the gap from client probe start to server request event. If this is high
   while `socketIdleBeforeHttpRequestEventMs` is low, the client spent time
   acquiring a socket from its pool before sending the request.
3. **Node request-event delivery** — `httpRequestEventToHandlerStartMs`
   measures the gap between the HTTP `request` event and the handler start.
   High values (>100ms) point to listener dispatch or pre-handler queue
   pressure rather than wire idle time.

To use the gate in an approved read-only diagnostic:

```bash
curl -s http://localhost:8787/schedz -H 'x-a2a-edge-secret: test' | jq '.operatorGate'
```

When a slow sample is classified as `reused-socket-idle-before-request-event`,
compare the sample's `socketIdleBeforeHttpRequestEventMs` and
`socketAcceptedToHttpRequestEventMs` with these settings. If the idle tail
clusters near `keepAliveTimeoutMs`, prioritize keep-alive expiry/race behavior.
If it is far below the configured timeout, prioritize client/runtime pooling
or event-loop/parser dispatch evidence before changing server timeout settings.

For an approved live gate, the comprehensive diagnostic script can compare all
`/livez` connection behaviors in one bounded report without changing broker
state:

```bash
# One report covering default runtime behavior, fresh connections, and
# keep-alive requests. Count is per mode and is capped for comparison runs.
BROKER_EDGE_SECRET=<from-owner-env> \
  node scripts/broker-comprehensive-diagnostics.mjs \
  --compare-livez-connection-modes --count 50 --interval 100 --json
```

The comparison report includes `perMode`, `deltas`, and
`comparisonConclusion`, plus each mode's `livezSpikeCorrelation` and bounded
`slowSampleAttributionRows`. Treat `default` as **runtime default behavior**,
not a clean control group; it may be fresh or reused depending on the
client/runtime pool. The report still uses observed `socketRequestIndex` and
`socketHadServedRequest` as the source of truth for reuse.

If an operator explicitly wants a single-mode run, the lower-level option is:

```bash
# Fresh-connection single mode: send Connection: close on /livez probes only.
BROKER_EDGE_SECRET=<from-owner-env> \
  node scripts/broker-comprehensive-diagnostics.mjs \
  --livez-connection-mode=fresh --count 50 --interval 100 --json

# Keep-alive comparison: send Connection: keep-alive on /livez probes only.
BROKER_EDGE_SECRET=<from-owner-env> \
  node scripts/broker-comprehensive-diagnostics.mjs \
  --livez-connection-mode=keep-alive --count 50 --interval 100 --json
```

The option affects `/livez` only. `/schedz` remains authenticated with
`x-a2a-edge-secret` and does not receive the connection-mode override. Keep the
comparison disabled unless the operator has approved a read-only live gate.
When an edge secret is present, the script refuses non-loopback base URLs unless
`--allow-non-loopback-edge-secret` is explicitly supplied for an approved
broker-local URL. Any `/livez` HTTP failure and any `/schedz` failure should be
treated as failed evidence.

## Interpreting Correlation

A stall episode typically shows one of these patterns:

| Pattern | Likely Cause |
|---|---|
| High `firstRequestLatencyMs`, low `handlerMs`, low `handlerToFinishGapMs`, low host load | Container cgroup CPU throttle / kernel scheduling delay |
| High `firstRequestLatencyMs`, high host `loadPerCpu` | Host CPU oversubscription |
| Low `firstRequestLatencyMs`, high `handlerMs`, low `handlerToFinishGapMs` | Handler-side work contention (SQLite, task queue, serialization) — handler body time dominates, pre-handler scheduling is clean |
| Low `firstRequestLatencyMs`, low `handlerMs`, high `handlerToFinishGapMs` | TCP/flush pressure; `handlerMs` stays low (handler body fast) but response flush is delayed. Check connection count, kernel TCP buffer pressure |
| Sudden burst of new connections + high first-request latency | Client reconnect storm; upstream proxy health check flood |
| `livezSpikeCorrelation.byConnectionReuse.firstRequest.count` dominates | Fresh connection path is more likely involved; compare with `--livez-connection-mode=fresh` |
| `livezSpikeCorrelation.byConnectionReuse.reusedSocket.count` dominates | Keep-alive reuse/socket idle path is more likely involved; compare with `--livez-connection-mode=keep-alive` |

## Local Verification

```bash
# Quick diagnostics
curl -s http://localhost:8787/schedz -H 'x-a2a-edge-secret: test' | jq '{
  connections: .connections,
  httpServer: .connections.httpServer,
  perRequest: .perRequest,
  flushing: .flushing,
  probeBursts: .probeBursts
}'

# Check handler timing decomposition
curl -s http://localhost:8787/schedz -H 'x-a2a-edge-secret: test' | jq '{ handlerMs: .perRequest.handlerMs, schedulingTiming: .schedulingTiming, flushGap: .flushing.handlerToFinishGapMs }'

# Check connection timing
curl -s http://localhost:8787/schedz -H 'x-a2a-edge-secret: test' | jq '.connections.connectionDurationMs'

# Check flush gap
curl -s http://localhost:8787/schedz -H 'x-a2a-edge-secret: test' | jq '.flushing'

# Stall attribution script (full analysis)
BROKER_EDGE_SECRET=<from-owner-env> \
  node scripts/broker-comprehensive-diagnostics.mjs --count 50 --interval 100 --json | jq
```

`/livez` is public by design, but `/schedz` is authenticated when
`EDGE_SECRET` is configured. The comprehensive diagnostic script reads the
edge secret from the normal worker/operator environment variable order
(`BROKER_EDGE_SECRET`, `A2A_BROKER_EDGE_SECRET`, `EDGE_SECRET`,
`A2A_EDGE_SECRET`) and sends it only as an HTTP header to `/schedz`; it does
not include the value in the JSON or Markdown report. A failed `/schedz`
probe or missing scheduling timing is a failed gate, not a passing report.

## Metrics Budget

All diagnostics are O(1), bounded in-memory, off the `/livez` hot path:

| Metric | Storage | Max Entries | Cleanup |
|---|---|---|---|
| `_schedulingTimingWindow` | In-memory array | 200 samples | Sliding window (evict oldest) |
| `_connectionDurationWindow` | In-memory array | 200 samples | Sliding window |
| `_firstRequestLatencyWindow` | In-memory array | 200 samples | Sliding window |
| `_socketAcceptedToHttpRequestEventWindow` | In-memory array | 200 samples | Sliding window |
| `_httpRequestEventToHandlerStartWindow` | In-memory array | 200 samples | Sliding window |
| `_socketIdleBeforeHttpRequestEventWindow` | In-memory array | 200 samples | Sliding window |
| `_clientProbeStartToHttpRequestEventWindow` | In-memory array | 200 samples | Sliding window |
| `_freshSocketAgeBeforeHandlerWindow` | In-memory array | 200 samples | Sliding window |
| `_freshSocketAcceptedToHttpRequestEventWindow` | In-memory array | 200 samples | Sliding window |
| `_reusedSocketIdleBeforeHttpRequestEventWindow` | In-memory array | 200 samples | Sliding window |
| `_reusedSocketAgeBeforeHandlerWindow` | In-memory array | 200 samples | Sliding window |
| `_handlerBodyWindow` | In-memory array | 200 samples | Sliding window |
| `_flushFinishGapWindow` | In-memory array | 200 samples | Sliding window |
| `_probeCounter` | In-memory Map | Unbounded per peer prefix | Entries >10s old skipped on read |
