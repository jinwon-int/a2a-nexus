import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, jsonHeaders } from "./server-test-helpers.js";

/**
 * #1601 usage probe for the terminal-brief sidecar gate surface.
 *
 * The 37 `POST /terminal-brief/sidecar/*` routes are pure projections returned
 * `no-store`. They persist nothing, so a live broker holds no evidence of
 * whether they are still called — which is exactly the evidence needed before
 * deciding whether the ~31k LOC behind them can be removed. These tests pin
 * the probe's contract: it records the route name and requester, it records
 * nothing about the request body, and it does not alter route behaviour.
 */

const SIDECAR_ACTION = "terminal_brief.sidecar.invoked";
const ROUTE = "default-on-candidate-final-gate";

function operatorHeaders() {
  return jsonHeaders({
    "x-a2a-edge-secret": "test-edge-secret",
    "x-a2a-requester-id": "operator-a",
    "x-a2a-requester-role": "operator",
  });
}

test("invoking a terminal-brief sidecar route records a usage audit event", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await fetch(server.baseUrl + "/terminal-brief/sidecar/" + ROUTE, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify({}),
    });

    const audits = server.runtime.broker.listAuditEvents({ action: SIDECAR_ACTION });
    assert.equal(audits.length, 1, "one invocation should record exactly one probe event");
    assert.equal(audits[0].actorId, "operator-a");
    assert.equal(audits[0].targetType, "broker");
    assert.equal(audits[0].targetId, `terminal-brief-sidecar:${ROUTE}`);
  } finally {
    await server.close();
  }
});

test("the usage probe records a malformed request too, so usage is not undercounted", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    // A caller that reaches an authorized route but sends an unusable body is
    // still a caller. Undercounting here would bias the removal decision toward
    // "unused", which is the expensive direction to be wrong in.
    await fetch(server.baseUrl + "/terminal-brief/sidecar/" + ROUTE, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify({ observationPacket: "not-an-object" }),
    });

    const audits = server.runtime.broker.listAuditEvents({ action: SIDECAR_ACTION });
    assert.equal(audits.length, 1);
  } finally {
    await server.close();
  }
});

test("the usage probe never captures request body content", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const secretish = "operator-instruction-telegram-1000000001-53345";
    await fetch(server.baseUrl + "/terminal-brief/sidecar/" + ROUTE, {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify({ observationPacket: { note: secretish } }),
    });

    const audits = server.runtime.broker.listAuditEvents({ action: SIDECAR_ACTION });
    assert.equal(audits.length, 1);
    const serialized = JSON.stringify(audits[0]);
    assert.equal(
      serialized.includes(secretish),
      false,
      "probe must not leak request body content into the audit trail",
    );
  } finally {
    await server.close();
  }
});

test("an unknown sidecar route records nothing", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await fetch(server.baseUrl + "/terminal-brief/sidecar/no-such-route", {
      method: "POST",
      headers: operatorHeaders(),
      body: JSON.stringify({}),
    });

    const audits = server.runtime.broker.listAuditEvents({ action: SIDECAR_ACTION });
    assert.equal(audits.length, 0, "only real routes count as sidecar surface usage");
  } finally {
    await server.close();
  }
});

test("repeated invocations accumulate, so observation can distinguish zero from rare", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    for (const route of [ROUTE, "dry-run-gate", ROUTE]) {
      await fetch(server.baseUrl + "/terminal-brief/sidecar/" + route, {
        method: "POST",
        headers: operatorHeaders(),
        body: JSON.stringify({}),
      });
    }

    const audits = server.runtime.broker.listAuditEvents({ action: SIDECAR_ACTION });
    assert.equal(audits.length, 3);
    const targets = audits.map((event) => event.targetId).sort();
    assert.deepEqual(targets, [
      `terminal-brief-sidecar:${ROUTE}`,
      `terminal-brief-sidecar:${ROUTE}`,
      "terminal-brief-sidecar:dry-run-gate",
    ]);
  } finally {
    await server.close();
  }
});
