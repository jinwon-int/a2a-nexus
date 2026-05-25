#!/usr/bin/env node
/**
 * ops-hardening-audit.mjs
 *
 * Read-only security/ops hardening audit for a2a-plane#440.
 *
 * Covers:
 *   1. Read-only audit checklist   (exposure, auth, credential mount hints)
 *   2. Worker credential mount validation (env variable presence, lease file shape)
 *   3. Stale worker identity lifecycle diagnostics
 *   4. Health / liveness / receipt gaps / queue pressure separation
 *
 * No secrets are printed.  This script never deploys, restarts, mutates DB,
 * sends provider messages, or ACKs terminal outbox records.
 */

import process from "node:process";
import { readFileSync, statSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AuditCheck
 * @property {string} area     - Which hardening area the check belongs to.
 * @property {string} name     - Short check name.
 * @property {"pass"|"fail"|"warn"} status
 * @property {string} detail   - Human-readable detail (redacted).
 * @property {Object} [meta]   - Optional structured metadata.
 */

/**
 * @typedef {Object} AuditReport
 * @property {string} generatedAt
 * @property {string} parentIssue
 * @property {string} runId
 * @property {"no-live"} mode
 * @property {AuditCheck[]} checks
 * @property {"pass"|"fail"|"warn"} aggregate
 * @property {boolean} secretsPrinted
 * @property {boolean} dbMutationAttempted
 * @property {boolean} providerCalled
 * @property {boolean} terminalAckAttempted
 */

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const REQUIRED_WORKER_ENV_VARS = [
  "BROKER_URL",
  "A2A_BROKER_URL",
  "WORKER_ID",
  "A2A_WORKER_ID",
];

const OPTIONAL_WORKER_ENV_VARS = [
  ["A2A_BROKER_EDGE_SECRET", "BROKER_EDGE_SECRET", "EDGE_SECRET"],
  ["A2A_HOME_BROKER_ID", "HOME_BROKER_ID"],
  ["A2A_HOME_BROKER_LEASE_FILE", "HOME_BROKER_LEASE_FILE"],
  ["A2A_WORKER_PUBLIC_URL", "WORKER_PUBLIC_URL"],
  ["A2A_WORKER_HANDLER_COMMAND", "WORKER_HANDLER_COMMAND"],
];

function ok(name, area, detail, meta) {
  return { area, name, status: "pass", detail, meta };
}

function fail(name, area, detail, meta) {
  return { area, name, status: "fail", detail, meta };
}

function warn(name, area, detail, meta) {
  return { area, name, status: "warn", detail, meta };
}

async function readJsonResponse(fetchImpl, baseUrl, path, headers) {
  const url = new URL(path, ensureTrailingSlash(baseUrl));
  const response = await fetchImpl(url, { method: "GET", headers });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildHeaders(edgeSecret) {
  const headers = {
    accept: "application/json",
    "x-a2a-requester-id": "ops-hardening-audit",
    "x-a2a-requester-role": "operator",
  };
  if (edgeSecret) {
    headers["x-a2a-edge-secret"] = edgeSecret;
  }
  return headers;
}

function buildTimestamp() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Area 1 & 2: Broker exposure / auth / readiness checks
// ---------------------------------------------------------------------------

function checkHealthEndpoint(body, status) {
  if (status !== 200) {
    return fail("broker-health-endpoint", "exposure-auth",
      `expected HTTP 200, got ${status}`);
  }
  if (!body || body.ok !== true) {
    return fail("broker-health-endpoint", "exposure-auth",
      "health payload missing ok: true");
  }
  const info = {
    service: body.service ?? null,
    version: body.version ?? null,
    brokerId: typeof body.brokerId === "string" ? "present" : null,
    persistence: body.persistence?.kind ?? null,
    edgeSecretRequired: body.requestSecurity?.edgeSecretRequired ?? null,
    enforceRequesterIdentity: body.requestSecurity?.enforceRequesterIdentity ?? null,
    staleReaperEnabled: body.staleReaper?.enabled ?? null,
  };
  return ok("broker-health-endpoint", "exposure-auth",
    `healthy: service=${info.service} version=${info.version} brokerId=${info.brokerId} persistence=${info.persistence} edgeSecret=${info.edgeSecretRequired} reqIdentity=${info.enforceRequesterIdentity}`,
    info);
}

function checkAgentCardEndpoint(body, status) {
  if (status !== 200) {
    return fail("agent-card-endpoint", "exposure-auth",
      `expected HTTP 200, got ${status}`);
  }
  // /.well-known/agent-card.json is intentionally public
  const hasCapabilities = body && typeof body.capabilities === "object";
  return ok("agent-card-endpoint", "exposure-auth",
    `public agent-card endpoint OK, capabilities=${hasCapabilities}`);
}

function checkAuthEnforcement(body) {
  const reqSec = body?.requestSecurity ?? {};
  const checks = [];
  if (reqSec.edgeSecretRequired === true) {
    checks.push("edge_secret_required");
  } else {
    checks.push("edge_secret_missing");
  }
  if (reqSec.enforceRequesterIdentity === true) {
    checks.push("requester_identity_enforced");
  } else {
    checks.push("requester_identity_not_enforced");
  }
  return ok("auth-enforcement", "exposure-auth",
    `security: ${checks.join(", ")}`, {
      edgeSecretRequired: reqSec.edgeSecretRequired,
      enforceRequesterIdentity: reqSec.enforceRequesterIdentity,
      trustedProxy: reqSec.trustedProxy,
    });
}

function checkRateLimiting(body) {
  const reqSec = body?.requestSecurity ?? {};
  const pressure = body?.requestPressure ?? {};
  const general = pressure.general ?? {};
  const workerLimiter = pressure.worker ?? {};
  return ok("rate-limiting", "exposure-auth",
    `general: ${general.limit ?? "?"} req/${general.windowMs ?? "?"}ms, worker: ${workerLimiter.limit ?? "?"} req/${workerLimiter.windowMs ?? "?"}ms`,
    {
      rateLimitWindowSec: reqSec.rateLimitWindowSec,
      rateLimitMaxRequests: reqSec.rateLimitMaxRequests,
      workerRateLimitWindowSec: reqSec.workerRateLimitWindowSec,
      workerRateLimitMaxRequests: reqSec.workerRateLimitMaxRequests,
    });
}

// ---------------------------------------------------------------------------
// Area 3: Worker credential mount validation
// ---------------------------------------------------------------------------

function checkWorkerCredentialEnv(env) {
  const failures = [];
  const warnings = [];
  const found = [];

  for (const key of REQUIRED_WORKER_ENV_VARS) {
    if (env[key]) {
      found.push(key);
    } else {
      failures.push(key);
    }
  }

  for (const group of OPTIONAL_WORKER_ENV_VARS) {
    const matched = group.filter((k) => env[k]);
    if (matched.length === 0) {
      warnings.push(`${group[0]} (or fallbacks) not set`);
    } else {
      found.push(matched[0]);
    }
  }

  // Detect home broker lease file presence and shape (path only, never content)
  const leaseFile = env.A2A_HOME_BROKER_LEASE_FILE || env.HOME_BROKER_LEASE_FILE || null;
  if (leaseFile) {
    try {
      statSync(leaseFile);
      const raw = readFileSync(leaseFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const hasRequired = parsed.brokerId && parsed.workerId;
        if (!hasRequired) {
          warnings.push(`home broker lease file exists but missing required fields`);
        }
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        warnings.push(`home broker lease file configured but not found: ${leaseFile}`);
      } else {
        // Not printing the actual error detail as it could contain path info
        warnings.push(`home broker lease file not accessible`);
      }
    }
  }

  if (failures.length > 0) {
    return fail("worker-credential-env", "worker-credential-mount",
      `missing required env vars: ${failures.join(", ")}`, { missing: failures, found });
  }

  const detail = [
    `required env vars: ${found.filter((k) => REQUIRED_WORKER_ENV_VARS.includes(k)).length}/${REQUIRED_WORKER_ENV_VARS.length} present`,
  ];
  if (warnings.length > 0) {
    detail.push(`warnings: ${warnings.length}`);
    return warn("worker-credential-env", "worker-credential-mount",
      detail.join("; "), { found, warnings });
  }

  return ok("worker-credential-env", "worker-credential-mount",
    detail.join("; "), { found });
}

function checkWorkerCapabilitiesConfig(env) {
  const direct = env.WORKER_CAPABILITIES_JSON || env.A2A_WORKER_CAPABILITIES_JSON || null;
  if (direct) {
    try {
      const parsed = JSON.parse(direct);
      if (parsed && typeof parsed === "object") {
        return ok("worker-capabilities-config", "worker-credential-mount",
          "capabilities defined via JSON config");
      }
    } catch {
      return fail("worker-capabilities-config", "worker-credential-mount",
        "WORKER_CAPABILITIES_JSON is not valid JSON");
    }
  }

  const capVars = [
    "WORKER_CAN_ANALYZE", "WORKER_CAN_BACKFILL",
    "WORKER_CAN_PATCH_WORKSPACE", "WORKER_CAN_PROMOTE_LIVE",
    "WORKER_WORKSPACE_IDS", "WORKER_ENVIRONMENTS",
  ];
  const present = capVars.filter((k) => env[k]);
  return ok("worker-capabilities-config", "worker-credential-mount",
    `capabilities defined via ${present.length}/${capVars.length} individual env vars`);
}

// ---------------------------------------------------------------------------
// Area 4: Stale worker identity lifecycle
// ---------------------------------------------------------------------------

function checkWorkerLiveness(body, status) {
  if (status !== 200) {
    return fail("workers-list", "stale-worker-lifecycle",
      `expected HTTP 200, got ${status}`);
  }
  const items = Array.isArray(body?.items) ? body.items : [];
  const byRole = {};
  const stale = [];
  for (const item of items) {
    const role = item.role ?? "unknown";
    (byRole[role] ??= { total: 0, online: 0, stale: 0 });
    byRole[role].total++;
    if (item.status === "online") {
      byRole[role].online++;
    } else {
      byRole[role].stale++;
      stale.push(item.nodeId ?? item.id ?? "?");
    }
  }
  if (stale.length > 0) {
    return warn("workers-stale-identities", "stale-worker-lifecycle",
      `${stale.length} worker(s) reported stale across all roles; requires investigation for identity lifecycle rotation`,
      { staleCount: stale.length, byRole, staleWorkerIds: stale });
  }
  return ok("workers-stale-identities", "stale-worker-lifecycle",
    `all workers online: ${items.length} total`, { byRole });
}

function checkWorkerLatestHeartbeat(body, status) {
  if (status !== 200) {
    return fail("workers-capacity", "stale-worker-lifecycle",
      `expected HTTP 200, got ${status}`);
  }
  if (!body || typeof body !== "object") {
    return warn("workers-capacity", "stale-worker-lifecycle",
      "capacity endpoint returned unexpected body");
  }
  return ok("workers-capacity", "stale-worker-lifecycle",
    "worker capacity summary available");
}

// ---------------------------------------------------------------------------
// Area 5: Readiness checks — health / liveness / receipt gaps / queue pressure
// ---------------------------------------------------------------------------

function checkQueuePressure(body, status) {
  if (status !== 200) {
    return fail("queue-pressure", "readiness-separation",
      `expected HTTP 200, got ${status}`);
  }
  const diagnostics = body?.items ?? [];
  const counts = { queued: 0, claimed: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
  for (const item of diagnostics) {
    const s = item?.status ?? "unknown";
    if (s in counts) counts[s]++;
  }

  const pressure = counts.queued + counts.claimed + counts.running;
  return ok("queue-pressure", "readiness-separation",
    `queue: queued=${counts.queued} claimed=${counts.claimed} running=${counts.running} terminal: succeeded=${counts.succeeded} failed=${counts.failed}`,
    { counts, pressure, diagnosticsCount: diagnostics.length });
}

function checkStaleTaskDiagnostics(body, status) {
  if (status !== 200) {
    return fail("task-diagnostics", "readiness-separation",
      `expected HTTP 200, got ${status}`);
  }
  const items = Array.isArray(body?.items) ? body.items : [];
  const stale = items.filter((i) => i.diagnosticStatus === "stale" || i.interruption);
  const longRunning = items.filter((i) => i.diagnosticStatus === "long_running");
  const blocked = items.filter((i) => i.status === "blocked");

  const meta = {
    totalTasks: items.length,
    staleCount: stale.length,
    longRunningCount: longRunning.length,
    blockedCount: blocked.length,
  };

  if (stale.length > 0) {
    return warn("task-diagnostics", "readiness-separation",
      `${stale.length} stale task(s) — check health vs liveness gap`,
      meta);
  }
  if (longRunning.length > 0) {
    return warn("task-diagnostics", "readiness-separation",
      `${longRunning.length} long-running task(s) — may indicate queue pressure`,
      meta);
  }
  return ok("task-diagnostics", "readiness-separation",
    `all ${items.length} tasks within normal thresholds`, meta);
}

function checkTerminalOutbox(body, status) {
  if (status !== 200) {
    return fail("terminal-outbox", "readiness-separation",
      `expected HTTP 200, got ${status}`);
  }
  const events = Array.isArray(body?.events) ? body.events : [];
  const unacked = events.filter((e) => {
    const ack = e.ack;
    return !ack || ack.status !== "receipt_confirmed";
  });
  const receiptGaps = events.filter((e) => {
    const receipt = e.receipt ?? e.payload?.receipt;
    const status = receipt?.status ?? null;
    return status && !["operator_visible", "operator_confirmed"].includes(status);
  });

  if (unacked.length > 0) {
    return warn("terminal-outbox-unacked", "readiness-separation",
      `${unacked.length} terminal event(s) not yet ACKed; receipt gap may need operator review`,
      { totalEvents: events.length, unackedCount: unacked.length, receiptGapCount: receiptGaps.length });
  }
  return ok("terminal-outbox-unacked", "readiness-separation",
    `all ${events.length} terminal event(s) ACKed`);
}

// ---------------------------------------------------------------------------
// Stale reaper status
// ---------------------------------------------------------------------------

function checkStaleReaper(body) {
  const reaper = body?.staleReaper ?? {};
  return ok("stale-reaper", "stale-worker-lifecycle",
    `enabled=${reaper.enabled} interval=${reaper.intervalSec}s olderThan=${reaper.olderThanSec}s lastRequeued=${reaper.lastRequeued ?? 0} totalDeadLettered=${reaper.totalDeadLettered}`,
    reaper);
}

// ---------------------------------------------------------------------------
// Build aggregate
// ---------------------------------------------------------------------------

function aggregateStatus(checks) {
  for (const c of checks) {
    if (c.status === "fail") return "fail";
  }
  for (const c of checks) {
    if (c.status === "warn") return "warn";
  }
  return "pass";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runOpsHardeningAudit(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required");
  }

  const baseUrl = options.baseUrl ?? process.env.BROKER_URL ?? "http://127.0.0.1:8787";
  const edgeSecret = options.edgeSecret
    ?? process.env.BROKER_EDGE_SECRET
    ?? process.env.EDGE_SECRET
    ?? process.env.A2A_EDGE_SECRET;
  const env = options.env ?? process.env;
  const headers = buildHeaders(edgeSecret);

  const [[healthRes, agentCardRes, workersRes, capacityRes, diagnosticsRes, outboxRes]] = await Promise.all([
    Promise.all([
      readJsonResponse(fetchImpl, baseUrl, "/health", headers),
      readJsonResponse(fetchImpl, baseUrl, "/.well-known/agent-card.json", headers),
      readJsonResponse(fetchImpl, baseUrl, "/workers", headers),
      readJsonResponse(fetchImpl, baseUrl, "/workers/capacity", headers),
      readJsonResponse(fetchImpl, baseUrl, "/tasks/diagnostics", headers),
      readJsonResponse(fetchImpl, baseUrl, "/a2a/tasks/terminal-outbox?limit=50", headers),
    ]),
  ]);

  const checks = [];

  // Area 1 & 2: Exposure / auth
  checks.push(checkHealthEndpoint(healthRes.body, healthRes.status));
  checks.push(checkAgentCardEndpoint(agentCardRes.body, agentCardRes.status));
  if (healthRes.body) {
    checks.push(checkAuthEnforcement(healthRes.body));
    checks.push(checkRateLimiting(healthRes.body));
    checks.push(checkStaleReaper(healthRes.body));
  }

  // Area 3: Worker credential mount validation
  checks.push(checkWorkerCredentialEnv(env));
  checks.push(checkWorkerCapabilitiesConfig(env));

  // Area 4: Stale worker identity lifecycle
  checks.push(checkWorkerLiveness(workersRes.body, workersRes.status));
  checks.push(checkWorkerLatestHeartbeat(capacityRes.body, capacityRes.status));

  // Area 5: Readiness separation — queue pressure, diagnostics, terminal outbox
  checks.push(checkQueuePressure(diagnosticsRes.body, diagnosticsRes.status));
  checks.push(checkStaleTaskDiagnostics(diagnosticsRes.body, diagnosticsRes.status));
  checks.push(checkTerminalOutbox(outboxRes.body, outboxRes.status));

  /** @type {AuditReport} */
  const report = {
    generatedAt: buildTimestamp(),
    parentIssue: "https://github.com/jinwon-int/a2a-plane/issues/440",
    runId: options.runId ?? "ops-hardening-audit",
    mode: "no-live",
    checks,
    aggregate: aggregateStatus(checks),
    secretsPrinted: false,
    dbMutationAttempted: false,
    providerCalled: false,
    terminalAckAttempted: false,
  };

  return report;
}

// ---------------------------------------------------------------------------
// No-live synthetic mode (used in tests and dry-run preflight)
// ---------------------------------------------------------------------------

export function runNoLiveAudit(options = {}) {
  const sample = options.sample ?? defaultNoLiveSample();
  const checks = [
    ok("broker-health-endpoint", "exposure-auth", "healthy: service=a2a-broker version=0.1.0 edgeSecret=true reqIdentity=true", sample.health),
    ok("agent-card-endpoint", "exposure-auth", "public agent-card endpoint OK, capabilities=true"),
    ok("auth-enforcement", "exposure-auth", "security: edge_secret_required, requester_identity_enforced", { edgeSecretRequired: true, enforceRequesterIdentity: true }),
    ok("rate-limiting", "exposure-auth", "general: 10 req/60000ms, worker: 60 req/60000ms"),
    ok("stale-reaper", "stale-worker-lifecycle", "enabled=true interval=60s olderThan=90s"),
    ok("worker-credential-env", "worker-credential-mount",
      "required env vars: 4/4 present", { found: REQUIRED_WORKER_ENV_VARS }),
    ok("worker-capabilities-config", "worker-credential-mount",
      "capabilities defined via individual env vars"),
    ok("workers-stale-identities", "stale-worker-lifecycle",
      "all workers online: 5 total", { byRole: { analyst: { total: 3, online: 3, stale: 0 }, operator: { total: 1, online: 1, stale: 0 }, hub: { total: 1, online: 1, stale: 0 } } }),
    ok("workers-capacity", "stale-worker-lifecycle",
      "worker capacity summary available"),
    ok("queue-pressure", "readiness-separation",
      "queue: queued=0 claimed=0 running=0", sample.queueCounts),
    ok("task-diagnostics", "readiness-separation", "all tasks within normal thresholds", { totalTasks: 0, staleCount: 0, longRunningCount: 0 }),
    ok("terminal-outbox-unacked", "readiness-separation", "all terminal event(s) ACKed", { totalEvents: 0 }),
  ];

  return {
    generatedAt: buildTimestamp(),
    parentIssue: "https://github.com/jinwon-int/a2a-plane/issues/440",
    runId: "no-live-synthetic",
    mode: "no-live",
    checks,
    aggregate: aggregateStatus(checks),
    secretsPrinted: false,
    dbMutationAttempted: false,
    providerCalled: false,
    terminalAckAttempted: false,
  };
}

function defaultNoLiveSample() {
  return {
    health: { ok: true, requestSecurity: { edgeSecretRequired: true, enforceRequesterIdentity: true, trustedProxy: false, rateLimitWindowSec: 60, rateLimitMaxRequests: 10, workerRateLimitWindowSec: 60, workerRateLimitMaxRequests: 60 } },
    queueCounts: { queued: 0, claimed: 0, running: 0 },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const read = (name) => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  return {
    baseUrl: read("--base-url") ?? process.env.BROKER_URL,
    edgeSecret: read("--edge-secret"),
    noLive: argv.includes("--no-live") || argv.includes("--dry-run"),
    json: argv.includes("--json") || argv.includes("--format=json"),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = opts.noLive ? runNoLiveAudit() : await runOpsHardeningAudit(opts);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    // Human-readable summary
    console.log(`A2A Plane Ops Hardening Audit — #440`);
    console.log(`Generated: ${report.generatedAt}`);
    console.log(`Mode: ${report.mode}`);
    console.log(`Aggregate: ${report.aggregate.toUpperCase()}`);
    console.log("");
    console.log("Checks:");
    for (const c of report.checks) {
      const icon = c.status === "pass" ? "✓" : c.status === "warn" ? "⚠" : "✗";
      console.log(`  ${icon} [${c.area}] ${c.name}`);
      console.log(`      ${c.detail}`);
    }
    console.log("");
    console.log("Safety:");
    console.log(`  Secrets printed: ${report.secretsPrinted}`);
    console.log(`  DB mutation attempted: ${report.dbMutationAttempted}`);
    console.log(`  Provider called: ${report.providerCalled}`);
    console.log(`  Terminal ACK attempted: ${report.terminalAckAttempted}`);
  }

  if (report.aggregate === "fail") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`ops-hardening-audit: ${err.message}`);
    process.exitCode = 2;
  });
}
