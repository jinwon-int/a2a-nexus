/**
 * Server-level auth-rejection observability (#1764).
 *
 * The pre-fix behaviour these tests pin down: a live broker answered an
 * unauthenticated request with 401 and its container log did not grow by a
 * single line, so a credential-rotation outage looked exactly like a dead
 * process for 22 hours. Each test below asserts one half of the fix — the
 * rejection becomes visible, and becoming visible does not leak the credential.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { startTestServer } from "./server-test-helpers.js";
import { resetAuthRejectionMetrics } from "./auth-rejection-metrics.js";

const EDGE_SECRET = "test-edge-secret-value";

/** Captures console.warn for the duration of `run`. */
async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return captured;
}

test("an edge-secret rejection is logged with a bounded reason (#1764)", async () => {
  resetAuthRejectionMetrics();
  const server = await startTestServer({ edgeSecret: EDGE_SECRET });
  try {
    let status = 0;
    const warnings = await captureWarnings(async () => {
      const res = await fetch(`${server.baseUrl}/workers`);
      status = res.status;
      await res.text();
    });

    assert.equal(status, 401, "the 401 contract is unchanged");
    const authLines = warnings.filter((line) => line.includes("auth rejected"));
    assert.equal(authLines.length, 1, "the rejection produces exactly one log line");
    assert.match(authLines[0] ?? "", /method=GET/);
    assert.match(authLines[0] ?? "", /route=workers\.list/);
    assert.match(authLines[0] ?? "", /reason=edge_secret_missing_or_invalid/);
    assert.match(authLines[0] ?? "", /count=1/);
  } finally {
    await server.close();
  }
});

test("the log line never contains the secret, the header value, or the raw message", async () => {
  resetAuthRejectionMetrics();
  const server = await startTestServer({ edgeSecret: EDGE_SECRET });
  try {
    const warnings = await captureWarnings(async () => {
      const res = await fetch(`${server.baseUrl}/workers`, {
        headers: { "x-a2a-edge-secret": "wrong-secret-attempt-value" },
      });
      await res.text();
    });

    const joined = warnings.join("\n");
    assert.match(joined, /auth rejected/, "the rejection is still visible");
    assert.equal(joined.includes(EDGE_SECRET), false, "the expected secret must never be logged");
    assert.equal(joined.includes("wrong-secret-attempt-value"), false, "the presented secret must never be logged");
    assert.equal(joined.includes("x-a2a-edge-secret is required"), false, "the raw message is not echoed");
  } finally {
    await server.close();
  }
});

test("repeated rejections are rate limited and report what they swallowed", async () => {
  resetAuthRejectionMetrics();
  const server = await startTestServer({ edgeSecret: EDGE_SECRET, rateLimitMaxRequests: 1000 });
  try {
    const warnings = await captureWarnings(async () => {
      for (let i = 0; i < 8; i += 1) {
        const res = await fetch(`${server.baseUrl}/workers`);
        await res.text();
      }
    });

    const authLines = warnings.filter((line) => line.includes("auth rejected"));
    assert.equal(authLines.length, 1, "a probing flood must not become the outage");
    assert.match(authLines[0] ?? "", /count=1/, "the first line is emitted before the burst accumulates");
  } finally {
    await server.close();
  }
});

test("/health exposes a bounded auth-rejection aggregate (#1764)", async () => {
  resetAuthRejectionMetrics();
  const server = await startTestServer({ edgeSecret: EDGE_SECRET });
  try {
    await captureWarnings(async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${server.baseUrl}/workers`);
        await res.text();
      }
    });

    const health = await fetch(`${server.baseUrl}/health`, {
      headers: { "x-a2a-edge-secret": EDGE_SECRET },
    });
    assert.equal(health.status, 200);
    const body = await health.json();
    const rejections = body.requestSecurity?.authRejections;

    assert.equal(rejections?.total, 3, "every rejection is counted, not just the logged one");
    assert.equal(rejections?.byReason?.edge_secret_missing_or_invalid, 3);
    assert.equal(rejections?.trackedKeys, 1);
    assert.equal(rejections?.droppedKeys, 0);
    assert.equal(rejections?.top?.[0]?.route, "workers.list");
    assert.equal(rejections?.top?.[0]?.reason, "edge_secret_missing_or_invalid");
    assert.match(rejections?.top?.[0]?.lastAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

    const raw = JSON.stringify(body);
    assert.equal(raw.includes(EDGE_SECRET), false, "the health body must not carry the secret");
  } finally {
    await server.close();
  }
});

test("an authorized request produces no auth-rejection log or counter movement", async () => {
  resetAuthRejectionMetrics();
  const server = await startTestServer({ edgeSecret: EDGE_SECRET });
  try {
    let status = 0;
    const warnings = await captureWarnings(async () => {
      const res = await fetch(`${server.baseUrl}/workers`, {
        headers: { "x-a2a-edge-secret": EDGE_SECRET },
      });
      status = res.status;
      await res.text();
    });

    assert.equal(status, 200);
    assert.equal(warnings.filter((l) => l.includes("auth rejected")).length, 0);

    const health = await fetch(`${server.baseUrl}/health`, {
      headers: { "x-a2a-edge-secret": EDGE_SECRET },
    });
    const body = await health.json();
    assert.equal(body.requestSecurity?.authRejections?.total, 0, "success must not be counted as rejection");
  } finally {
    await server.close();
  }
});

test("distinct routes are attributed separately so the failing surface is identifiable", async () => {
  resetAuthRejectionMetrics();
  const server = await startTestServer({ edgeSecret: EDGE_SECRET });
  try {
    await captureWarnings(async () => {
      for (const path of ["/workers", "/tasks", "/health"]) {
        const res = await fetch(`${server.baseUrl}${path}`);
        await res.text();
      }
    });

    const health = await fetch(`${server.baseUrl}/health`, {
      headers: { "x-a2a-edge-secret": EDGE_SECRET },
    });
    const body = await health.json();
    const routes = (body.requestSecurity?.authRejections?.top ?? []).map((e: { route: string }) => e.route);

    assert.equal(routes.length, 3, "three routes rejected, three distinct keys");
    for (const expected of ["workers.list", "tasks.list", "health"]) {
      assert.ok(routes.includes(expected), `expected ${expected} in ${JSON.stringify(routes)}`);
    }
  } finally {
    await server.close();
  }
});
