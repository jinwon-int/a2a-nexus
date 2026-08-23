/**
 * Slice L, first part: GET /readyz re-reads the serving fence.
 *
 * No non-serving middleware, no background monitor, no /health
 * stateContract, and no 488/489.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SHARED_STATE_SQLITE_ADAPTER_V1 } from "./shared-state-sqlite-adapter-v1.js";
import { startTestServer } from "./server-test-helpers.js";

test("/readyz is public and reports ready while the fence is held", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const res = await fetch(`${server.baseUrl}/readyz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ready, true);
    assert.equal(body.effectiveGrade, "single-process");
    assert.deepEqual(body.reasonCodes, []);
    assert.equal(Object.hasOwn(body, "configuredGrade"), false);
    assert.equal(Object.hasOwn(body, "gradeDefaulted"), false);
    assert.equal(JSON.stringify(body).includes("owner_token"), false);
    assert.equal(JSON.stringify(body).includes("shared-state-v1"), false);

    const livez = await fetch(`${server.baseUrl}/livez`);
    assert.equal(livez.status, 200);

    const health = await fetch(`${server.baseUrl}/health`, {
      headers: { "x-a2a-edge-secret": "s" },
    });
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(Object.hasOwn(healthBody, "configuredGrade"), false);
    assert.equal(Object.hasOwn(healthBody, "stateContract"), false);
  } finally {
    await server.close();
  }
});

test("/readyz is 503 lost_fence after the ownership row is stolen; other routes still serve", async () => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-readyz-"));
  const sharedStateFile = join(directory, "fence.sqlite");
  const server = await startTestServer({
    edgeSecret: "s",
    sharedStateFile,
  });
  try {
    const ready = await fetch(`${server.baseUrl}/readyz`);
    assert.equal(ready.status, 200);

    const db = new DatabaseSync(sharedStateFile, { timeout: 0 });
    db.prepare(
      `UPDATE shared_state_ownership SET owner_token = ? WHERE id = ?`,
    ).run("foreign-token", SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);
    db.close();

    const lost = await fetch(`${server.baseUrl}/readyz`);
    assert.equal(lost.status, 503);
    const body = await lost.json();
    assert.equal(body.ready, false);
    assert.deepEqual(body.reasonCodes, ["lost_fence"]);
    assert.equal(JSON.stringify(body).includes("foreign-token"), false);

    const livez = await fetch(`${server.baseUrl}/livez`);
    assert.equal(livez.status, 200);

    const workers = await fetch(`${server.baseUrl}/workers`, {
      headers: { "x-a2a-edge-secret": "s" },
    });
    assert.equal(workers.status, 200);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
