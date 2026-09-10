# Phase 6 preconditions evidence — live shadow (§5, #1504)

Captured 2026-09-10 (Slice ZB). Target: the T1 production broker host
(the host and broker identifiers are recorded in internal operations
memory, not in public docs). No OpenClaw runtime/bootstrap context enters this evidence. Secrets are
not recorded; only configuration names and non-sensitive values. Mutable
facts carry their capture timestamp and MUST be re-verified at any later
authorization gate.

## Precondition 1 — exact production revision/config/backend identified

- Serving container: the production broker container (image `broker-a2a-broker`, tag prefix
  `github`), port `127.0.0.1:8787→8787`, `Up 8 hours (healthy)`,
  `RestartCount 0`, restart policy `unless-stopped` (captured 2026-09-10
  ~08:50 UTC).
- Exact production revision: **`20812f73aaee8b18c5a85796d50ada6a1d410102`**
  (`build-info.json`: version 0.1.0, image tag `github-20812f7`, built
  2026-09-10T00:39:40Z, runtime docker).
- Backend: `BROKER_PERSISTENCE_BACKEND=sqlite`,
  `BROKER_SQLITE_LOAD_SOURCE=hot-tables`,
  `BROKER_PERSISTENCE_QUEUE_WORKER_THREAD=1`,
  `BROKER_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS=60000`,
  `BROKER_MAX_TERMINAL_TASKS=500`, `BROKER_MAX_REQUEUE_ATTEMPTS=2`,
  `WORKER_OFFLINE_AFTER_SEC=300`,
  `WORKER_RATE_LIMIT_WINDOW_SEC=60` / `WORKER_RATE_LIMIT_MAX_REQUESTS=120`.
- Shared-state integration flags: **absent from the environment** → all six
  (`BROKER_SHARED_STATE_V1_{REPLAY,RATE,LEASE,IDEMPOTENCY,OUTBOX,GRAPH}`)
  are default-off in production, as required.
- **Gap noted**: the production revision `20812f7` predates Phases 4–5 (the
  primitive integrations and the rehearsal harness landed on main up to
  `f53cab7`). The Phase 6 shadow runtime MUST be built from a post-Phase-5
  main; the production build is untouched until Phase 7 gates.

## Precondition 4 — topology proves exactly one serving process

- Host process inventory (captured 2026-09-10 ~08:50 UTC): exactly one broker
  process — the container's `packages/broker/dist/server.js`. The one other
  host node process named `server.js` (a loopback-port memo service) is NOT a
  broker; host-level listeners were enumerated to prove it.
- Exactly one broker container; exactly one `server.js` process inside it.
- `/livez` → ok, not draining; `/readyz` →
  `{"ready":true,"effectiveGrade":"single-process","reasonCodes":[]}`.
- No second broker listener on the host.

## Precondition 2 — backup/restore rehearsal + rollback owner recorded

- Backup set: `/var/lib/a2a-broker/backups/pre-phase6-shadow-20260910T085435Z/`
  (inside the a2a-broker volume): raw `state.sqlite` + `-wal` + `-shm`
  (300,924,928 bytes db) **and** the canonical hot-tables export
  `state-export.json` (37,788,043 bytes) produced by
  `export-sqlite-state.mjs --load-source hot-tables`.
- Restore rehearsal on the copied DB: `PRAGMA integrity_check` = **ok**;
  `broker_tasks` = 676 (matches the export's 676); `broker_terminal_outbox` =
  **1048** in the DB vs **1000** in the export.
- **Finding (migration-planning constraint)**: the hot-tables export caps
  `terminalOutbox` at
  `DEFAULT_TERMINAL_TASK_OUTBOX_RETENTION = 1000`
  (terminal-event-outbox retention), so the canonical JSON export is NOT a
  complete outbox backup while the live ledger exceeds 1000 rows. Phase 7
  gate 6 ("outbox IDs/sequences/ACKs compare exactly") therefore requires the
  **raw DB copy** as the migration source (or the export cap lifted/raised
  before cutover); the JSON export remains the task-state restore artifact.
- **Rollback owner**: the operator — the name is recorded in internal
  operations memory per the public-docs identity policy; the owner is the
  sole approver/executor of any rollback action for this effort.

## Precondition 3 — maintenance / maximum security-window plan (DRAFT for approval)

- The Phase 6 shadow itself is read-only (separate namespace/schema; legacy
  stays the only source of truth; live reads return legacy results only) and
  requires **no maintenance window**.
- Any later non-serving drain (Phase 7, or an emergency stop) must span the
  maximum security window: signature-expiry replay TTL bound (request-
  lifetime bounded) + the configured rate windows (general 60s, worker 60s at
  capture). **Proposed approved window: 15 minutes** of non-serving drain —
  comfortably above the ~6-minute theoretical maximum — reusable for every
  Phase 7 gate that needs it. PENDING OPERATOR APPROVAL.

## Environment notes for the shadow harness

- Container node is v22.23.2; its `node:sqlite` rejected GROUP BY and
  parameterized `get()` probes with `SQL logic error` during evidence
  capture (simple COUNT/PRAGMA worked). Shadow-side reads should use simple
  prepared statements or run their queries from a newer-node host against a
  copied DB.
- Live store paths: the broker state volume's `state.sqlite` (legacy broker
  state, WAL mode, actively written) and the `*.shared-state-v1.sqlite`
  serving-fence CAS store (tiny, ownership/clock-floor only). Exact paths
  are recorded in internal operations memory.
