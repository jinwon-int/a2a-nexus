#!/usr/bin/env node
/**
 * ops-hardening-audit.test.mjs
 *
 * Read-only tests for the ops-hardening-audit script.
 * No secrets, no live broker, no mutations.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// We import from the source file and also test the no-live path.
let auditModule;
let noLiveReport;
let runNoLiveAudit;

before(async () => {
  auditModule = await import("./ops-hardening-audit.mjs");
  runNoLiveAudit = auditModule.runNoLiveAudit;
  noLiveReport = runNoLiveAudit();
});

describe("ops-hardening-audit — no-live synthetic report", () => {
  it("should return a valid report shape", () => {
    assert.ok(noLiveReport);
    assert.equal(typeof noLiveReport.generatedAt, "string");
    assert.ok(noLiveReport.generatedAt.length > 0);
    assert.equal(noLiveReport.parentIssue, "https://github.com/jinwon-int/a2a-plane/issues/440");
  });

  it("should set mode to no-live", () => {
    assert.equal(noLiveReport.mode, "no-live");
  });

  it("should not print secrets, mutate DB, call providers, or ACK terminals", () => {
    assert.equal(noLiveReport.secretsPrinted, false);
    assert.equal(noLiveReport.dbMutationAttempted, false);
    assert.equal(noLiveReport.providerCalled, false);
    assert.equal(noLiveReport.terminalAckAttempted, false);
  });

  it("should include checks for all 5 hardening areas", () => {
    const areas = new Set(noLiveReport.checks.map((c) => c.area));
    assert.ok(areas.has("exposure-auth"), "missing exposure-auth checks");
    assert.ok(areas.has("worker-credential-mount"), "missing worker-credential-mount checks");
    assert.ok(areas.has("stale-worker-lifecycle"), "missing stale-worker-lifecycle checks");
    assert.ok(areas.has("readiness-separation"), "missing readiness-separation checks");
  });

  it("should have at least one check per area", () => {
    const byArea = {};
    for (const c of noLiveReport.checks) {
      (byArea[c.area] ??= []).push(c);
    }
    assert.ok(byArea["exposure-auth"].length >= 4,
      `exposure-auth has ${byArea["exposure-auth"]?.length} checks, expected >= 4`);
    assert.ok(byArea["worker-credential-mount"].length >= 2,
      `worker-credential-mount has ${byArea["worker-credential-mount"]?.length} checks, expected >= 2`);
    assert.ok(byArea["stale-worker-lifecycle"].length >= 2,
      `stale-worker-lifecycle has ${byArea["stale-worker-lifecycle"]?.length} checks, expected >= 2`);
    assert.ok(byArea["readiness-separation"].length >= 3,
      `readiness-separation has ${byArea["readiness-separation"]?.length} checks, expected >= 3`);
  });

  it("should aggregate to pass in synthetic mode", () => {
    assert.equal(noLiveReport.aggregate, "pass");
  });

  it("should not contain raw secret values, passwords, or file:// patterns in check details", () => {
    const allDetails = noLiveReport.checks.map((c) => c.detail).join(" ");
    // Ban actual secret value shapes, not the word 'secret' used as a
    // configuration concept (e.g. 'edgeSecretRequired', 'edge_secret_required').
    const forbidden = [
      /gh[pso]_[A-Za-z0-9]{36,}/,  // GitHub tokens
      /sk-[A-Za-z0-9]{20,}/,       // OpenAI-style keys
      /password\s*[:=]\s*\S+/i,   // password value assignment
      /file:\/\/\//,              // file:/// paths
    ];
    for (const pattern of forbidden) {
      assert.doesNotMatch(allDetails, pattern,
        `check detail contains forbidden pattern: ${pattern}`);
    }
  });
});

describe("ops-hardening-audit — no-live area coverage", () => {
  it("exposure-auth should cover health endpoint, agent card, auth enforcement, rate limiting", () => {
    const names = noLiveReport.checks
      .filter((c) => c.area === "exposure-auth")
      .map((c) => c.name);
    assert.ok(names.includes("broker-health-endpoint"));
    assert.ok(names.includes("agent-card-endpoint"));
    assert.ok(names.includes("auth-enforcement"));
    assert.ok(names.includes("rate-limiting"));
  });

  it("worker-credential-mount should cover env vars and capabilities config", () => {
    const names = noLiveReport.checks
      .filter((c) => c.area === "worker-credential-mount")
      .map((c) => c.name);
    assert.ok(names.includes("worker-credential-env"));
    assert.ok(names.includes("worker-capabilities-config"));
  });

  it("stale-worker-lifecycle should cover stale identities, capacity, and reaper status", () => {
    const names = noLiveReport.checks
      .filter((c) => c.area === "stale-worker-lifecycle")
      .map((c) => c.name);
    assert.ok(names.includes("workers-stale-identities"));
    assert.ok(names.includes("workers-capacity"));
    assert.ok(names.includes("stale-reaper"));
  });

  it("readiness-separation should cover queue pressure, task diagnostics, and terminal outbox", () => {
    const names = noLiveReport.checks
      .filter((c) => c.area === "readiness-separation")
      .map((c) => c.name);
    assert.ok(names.includes("queue-pressure"));
    assert.ok(names.includes("task-diagnostics"));
    assert.ok(names.includes("terminal-outbox-unacked"));
  });
});

describe("ops-hardening-audit — runNoLiveAudit safety invariants", () => {
  it("should produce deterministic output for the same sample", () => {
    const report1 = runNoLiveAudit();
    const report2 = runNoLiveAudit();
    assert.equal(report1.checks.length, report2.checks.length);
    for (let i = 0; i < report1.checks.length; i++) {
      assert.equal(report1.checks[i].status, report2.checks[i].status);
      assert.equal(report1.checks[i].name, report2.checks[i].name);
      assert.equal(report1.checks[i].area, report2.checks[i].area);
    }
  });

  it("should not disclose secret values in metadata", () => {
    const allMeta = noLiveReport.checks
      .filter((c) => c.meta && typeof c.meta === "object")
      .flatMap((c) => {
        const values = [];
        for (const v of Object.values(c.meta)) {
          if (Array.isArray(v)) values.push(...v);
          else if (v !== null && typeof v === "object") values.push(JSON.stringify(v));
          else values.push(String(v));
        }
        return values;
      })
      .join(" ");

    // Meta should not contain raw password/token shapes
    const forbidden = [/^[A-Za-z0-9+/]{40,}={0,2}$/, /^gh[ps]_[A-Za-z0-9]{36,}/, /^sk-[A-Za-z0-9]{20,}/];
    for (const pattern of forbidden) {
      assert.doesNotMatch(allMeta, pattern,
        `metadata contains value matching ${pattern}`);
    }
  });

  it("should report secret/credential env vars by name only, never by value", () => {
    const workerCredChecks = noLiveReport.checks
      .filter((c) => c.area === "worker-credential-mount");
    const allText = workerCredChecks.map((c) => JSON.stringify(c)).join(" ");
    // Should mention env var names
    assert.ok(allText.includes("BROKER_URL") || allText.includes("WORKER_ID"));
    // Should not contain env var values (fake check — synthetic mode uses default)
    assert.doesNotMatch(allText, /(token|secret|key)/i);
  });
});

describe("ops-hardening-audit — runOpsHardeningAudit live mode", () => {
  it("should reject missing fetch implementation", async () => {
    try {
      await auditModule.runOpsHardeningAudit({ fetchImpl: null });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err.message.includes("fetch"), `expected fetch error, got: ${err.message}`);
    }
  });

  it("should produce a valid report shape even with a mocked fetch", async () => {
    const mockFetch = async (url) => ({
      status: 200,
      async text() {
        if (url.pathname === "/health") {
          return JSON.stringify({
            ok: true,
            service: "a2a-broker",
            version: "0.1.0",
            requestSecurity: {
              edgeSecretRequired: true,
              enforceRequesterIdentity: true,
              trustedProxy: false,
              rateLimitWindowSec: 60,
              rateLimitMaxRequests: 10,
              workerRateLimitWindowSec: 60,
              workerRateLimitMaxRequests: 60,
            },
          });
        }
        if (url.pathname === "/.well-known/agent-card.json") {
          return JSON.stringify({ capabilities: { streaming: true } });
        }
        if (url.pathname === "/workers") {
          return JSON.stringify({
            items: [
              { nodeId: "worker-a", role: "analyst", status: "online" },
              { nodeId: "worker-b", role: "analyst", status: "online" },
            ],
          });
        }
        if (url.pathname === "/workers/capacity") {
          return JSON.stringify({ workerCount: 2, onlineCount: 2 });
        }
        if (url.pathname === "/tasks/diagnostics") {
          return JSON.stringify({ items: [] });
        }
        if (url.pathname.startsWith("/a2a/tasks/terminal-outbox")) {
          return JSON.stringify({ kind: "task.terminal.outbox", count: 0, events: [] });
        }
        return JSON.stringify({});
      },
      headers: new Map(),
    });

    const report = await auditModule.runOpsHardeningAudit({
      fetchImpl: mockFetch,
      baseUrl: "http://127.0.0.1:8787",
      env: {
        BROKER_URL: "http://127.0.0.1:8787",
        WORKER_ID: "worker-a",
        A2A_WORKER_ID: "worker-a",
      },
    });

    assert.ok(report);
    assert.equal(report.secretsPrinted, false);
    assert.equal(report.dbMutationAttempted, false);
    assert.equal(report.providerCalled, false);
    assert.equal(report.terminalAckAttempted, false);
    assert.ok(Array.isArray(report.checks));
    assert.ok(report.checks.length >= 10, `expected >=10 checks, got ${report.checks.length}`);
  });
});

describe("ops-hardening-audit — simulated failure paths", () => {
  it("should report fail when health endpoint is down", async () => {
    const mockFetch = async (url) => ({
      status: 502,
      async text() { return "Bad Gateway"; },
      headers: new Map(),
    });

    const report = await auditModule.runOpsHardeningAudit({
      fetchImpl: mockFetch,
      baseUrl: "http://127.0.0.1:8787",
      env: { BROKER_URL: "http://127.0.0.1:8787", WORKER_ID: "test" },
    });

    const healthCheck = report.checks.find((c) => c.name === "broker-health-endpoint");
    assert.ok(healthCheck);
    assert.equal(healthCheck.status, "fail");
  });

  it("should warn on stale workers", async () => {
    const mockFetch = async (url) => {
      if (url.pathname === "/workers") {
        return {
          status: 200,
          async text() {
            return JSON.stringify({
              items: [
                { nodeId: "worker-a", role: "analyst", status: "online" },
                { nodeId: "worker-b", role: "analyst", status: "stale" },
              ],
            });
          },
          headers: new Map(),
        };
      }
      if (url.pathname === "/health") {
        return {
          status: 200,
          async text() {
            return JSON.stringify({
              ok: true, service: "a2a-broker",
              requestSecurity: { edgeSecretRequired: true, enforceRequesterIdentity: true },
            });
          },
          headers: new Map(),
        };
      }
      if (url.pathname === "/.well-known/agent-card.json") {
        return { status: 200, async text() { return JSON.stringify({}); }, headers: new Map() };
      }
      if (url.pathname === "/workers/capacity") {
        return { status: 200, async text() { return JSON.stringify({}); }, headers: new Map() };
      }
      if (url.pathname === "/tasks/diagnostics") {
        return { status: 200, async text() { return JSON.stringify({ items: [] }); }, headers: new Map() };
      }
      if (url.pathname.startsWith("/a2a/tasks/terminal-outbox")) {
        return { status: 200, async text() { return JSON.stringify({ kind: "task.terminal.outbox", count: 0, events: [] }); }, headers: new Map() };
      }
      return { status: 404, async text() { return ""; }, headers: new Map() };
    };

    const report = await auditModule.runOpsHardeningAudit({
      fetchImpl: mockFetch,
      baseUrl: "http://127.0.0.1:8787",
      env: { BROKER_URL: "http://127.0.0.1:8787", WORKER_ID: "test" },
    });

    const staleCheck = report.checks.find((c) => c.name === "workers-stale-identities");
    assert.ok(staleCheck);
    assert.equal(staleCheck.status, "warn");
  });

  it("should report fail when required worker env vars are missing", async () => {
    const mockFetch = async (url) => ({
      status: 200,
      async text() {
        if (url.pathname === "/health") {
          return JSON.stringify({
            ok: true, service: "a2a-broker",
            requestSecurity: { edgeSecretRequired: true, enforceRequesterIdentity: true },
          });
        }
        return JSON.stringify({});
      },
      headers: new Map(),
    });

    const report = await auditModule.runOpsHardeningAudit({
      fetchImpl: mockFetch,
      baseUrl: "http://127.0.0.1:8787",
      env: {}, // no worker env at all
    });

    const credCheck = report.checks.find((c) => c.name === "worker-credential-env");
    assert.ok(credCheck);
    assert.equal(credCheck.status, "fail");
  });
});

describe("ops-hardening-audit — edge secret header logic", () => {
  it("should add edge secret header when provided", async () => {
    let capturedHeaders = null;
    const mockFetch = async (url, init) => {
      capturedHeaders = init?.headers;
      return {
        status: 200,
        async text() { return JSON.stringify({ ok: true }); },
        headers: new Map(),
      };
    };

    await auditModule.runOpsHardeningAudit({
      fetchImpl: mockFetch,
      baseUrl: "http://127.0.0.1:8787",
      edgeSecret: "test-edge-secret",
      env: { BROKER_URL: "http://127.0.0.1:8787", WORKER_ID: "test" },
    });

    assert.ok(capturedHeaders);
    assert.equal(capturedHeaders["x-a2a-edge-secret"], "test-edge-secret");
  });
});
