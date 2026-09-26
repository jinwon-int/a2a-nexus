/**
 * #1504 Phase 7 prerequisite P4 — local rollback rehearsal (gate 7).
 *
 * Phase 7 turns `BROKER_SHARED_STATE_V1_REPLAY` (then `_RATE`) on, and its
 * rollback turns it off again. This file rehearses on → off → on with
 * three real broker servers over ONE real SQLite serving-fence file, as
 * the T1 host would run them:
 *
 * - every phase answers without a single 503 / `state_unavailable`;
 * - every clean stop releases the fence (`owner_token` NULL) and every
 *   start bumps `lifecycle_epoch`, so the epoch strictly increases
 *   (E, E+1, E+2 — the fence never regresses);
 * - V1 replay/rate state written while the flag was on survives the off
 *   phase and is enforced again when the flag comes back on;
 * - the live shadow never reports `unexplained`.
 *
 * It also pins the two KNOWN rollback gaps as current behavior, because
 * they are why Phase 7's drain must cover the signature-expiry and rate
 * windows before the broker restarts in either direction:
 *
 * 1. while the flag is off, the process-local replay cache and limiter
 *    start empty, so a nonce V1 already holds is accepted and a V1-exhausted
 *    rate bucket admits again;
 * 2. nonces consumed while the flag is off never reach V1, so after the
 *    flag returns on the same signed request is accepted once more.
 *
 * If either assertion ever flips, that is a behavior change the Phase 7
 * plan must re-read, not a flaky test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildA2AHttpSignatureBase } from "./core/request-security.js";
import type { BrokerServerOptions } from "./server.js";
import { startTestServer, workerPayload } from "./server-test-helpers.js";

// Same fixture key pair as server-shared-state-replay-v1.test.ts.
const privateJwk = {
  crv: "Ed25519",
  d: "AaTuhLv-jaClRWi80aTnBCH7OaqKDTRI1-BhVY6n8hw",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
} as const;
const keyRegistry = {
  "worker:workerbeta:v1": {
    keyid: "worker:workerbeta:v1",
    workerId: "workerbeta",
    publicKeyJwk: { crv: "Ed25519", x: privateJwk.x, kty: "OKP" },
  },
};

const REGISTER_BODY = JSON.stringify(workerPayload("workerbeta"));

/**
 * Signed register headers for one nonce against one phase's authority. The
 * replay decision is keyed by the signing key and nonce, not the authority,
 * so re-signing the same nonce for a later phase's port models "the same
 * worker nonce arrives again" exactly; within a phase the identical headers
 * are replayed byte-for-byte.
 */
function signedRegisterHeaders(nonce: string, created: number, baseUrl: string): Record<string, string> {
  const headers = {
    "content-type": "application/json",
    "content-digest": `sha-256=:${createHash("sha256").update(Buffer.from(REGISTER_BODY)).digest("base64")}:`,
    "x-a2a-requester-id": "workerbeta",
    "x-a2a-requester-role": "analyst",
    "x-a2a-broker-id": "brokeralpha",
  };
  const expires = created + 60;
  const signatureInput = `a2a=("@method" "@authority" "@path" "@query" "content-digest" "x-a2a-requester-id" "x-a2a-requester-role" "x-a2a-broker-id");alg="ed25519";keyid="worker:workerbeta:v1";created=${created};expires=${expires};nonce="${nonce}";tag="a2a-worker-v1"`;
  const base = buildA2AHttpSignatureBase({
    method: "POST",
    authority: new URL(baseUrl).host,
    path: "/workers/register",
    query: "",
    headers,
    signatureInput,
  });
  const signature = sign(null, Buffer.from(base), createPrivateKey({ key: privateJwk, format: "jwk" })).toString("base64");
  return { ...headers, "signature-input": signatureInput, signature: `a2a=:${signature}:` };
}

interface PhaseLog {
  readonly statuses: number[];
  readonly errorCodes: string[];
}

async function send(
  log: PhaseLog,
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    body = {};
  }
  log.statuses.push(res.status);
  const code = (body.error as { code?: unknown } | undefined)?.code;
  if (typeof code === "string") log.errorCodes.push(code);
  return { status: res.status, body };
}

async function register(log: PhaseLog, baseUrl: string, headers: Record<string, string>) {
  const result = await send(log, baseUrl, "/workers/register", { method: "POST", headers, body: REGISTER_BODY });
  const message = String((result.body.error as { message?: unknown } | undefined)?.message ?? "");
  return { status: result.status, replay: result.status === 401 && /a2a_signature_replay/.test(message) };
}

function readFence(file: string): { ownerToken: string | null; epoch: bigint } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT owner_token, lifecycle_epoch FROM shared_state_ownership WHERE id = 1")
      .get() as { owner_token: string | null; lifecycle_epoch: string };
    return { ownerToken: row.owner_token, epoch: BigInt(row.lifecycle_epoch) };
  } finally {
    db.close();
  }
}

function assertNoUnavailable(phase: string, log: PhaseLog): void {
  assert.equal(log.statuses.filter((s) => s === 503).length, 0, `${phase}: no 503 (statuses=${log.statuses.join(",")})`);
  assert.ok(!log.errorCodes.includes("state_unavailable"), `${phase}: no state_unavailable`);
}

async function shadowUnexplained(log: PhaseLog, baseUrl: string): Promise<number> {
  const { body } = await send(log, baseUrl, "/health", { headers: { "x-a2a-requester-id": "rehearsal-probe" } });
  const shadow = body.stateShadow as { replay: { unexplained: number }; rate: { unexplained: number } } | undefined;
  assert.ok(shadow, "stateShadow block present with the shadow on");
  return shadow.replay.unexplained + shadow.rate.unexplained;
}

test("P4 rehearsal: V1 on → off → on keeps the fence monotonic, never 503s, and re-enforces V1 state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-p7-rollback-rehearsal-"));
  const sharedStateFile = join(directory, "state.json.shared-state-v1.sqlite");
  const shadowStateFile = join(directory, "state.json.shadow-v1.sqlite");
  const phase = (v1: boolean): Partial<BrokerServerOptions> => ({
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: keyRegistry,
    sharedStateReplayV1: v1,
    sharedStateRateV1: v1,
    sharedStateShadowV1: true,
    sharedStateFile,
    shadowStateFile,
    rateLimitMaxRequests: 3,
    workerRateLimitMaxRequests: 1_000,
  });
  const created = Math.floor(Date.now() / 1000) - 1;
  const NONCE_ON = "p4-nonce-consumed-while-on";
  const NONCE_OFF = "p4-nonce-consumed-while-off";
  const NONCE_FRESH = "p4-nonce-fresh-after-rollback";
  const rateHeaders = { "x-a2a-requester-id": "p4-rate-bucket" };
  const epochs: bigint[] = [];

  try {
    // ── Phase A: flag ON (Phase 7 cutover state) ─────────────────────────
    const logA: PhaseLog = { statuses: [], errorCodes: [] };
    const a = await startTestServer(phase(true));
    try {
      epochs.push(readFence(sharedStateFile).epoch);
      assert.notEqual(readFence(sharedStateFile).ownerToken, null, "running broker holds the fence");
      const onA = signedRegisterHeaders(NONCE_ON, created, a.baseUrl);
      assert.equal((await register(logA, a.baseUrl, onA)).status, 201);
      assert.equal((await register(logA, a.baseUrl, onA)).replay, true, "V1 rejects the replay");
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await send(logA, a.baseUrl, "/health", { headers: rateHeaders })).status, 200);
      }
      assert.equal((await send(logA, a.baseUrl, "/health", { headers: rateHeaders })).status, 429, "V1 bucket exhausted");
      assert.equal(await shadowUnexplained(logA, a.baseUrl), 0);
    } finally {
      await a.close();
    }
    assertNoUnavailable("phase A (on)", logA);
    assert.equal(readFence(sharedStateFile).ownerToken, null, "clean stop releases the fence");

    // ── Phase B: flag OFF (rollback) ─────────────────────────────────────
    const logB: PhaseLog = { statuses: [], errorCodes: [] };
    const b = await startTestServer(phase(false));
    try {
      epochs.push(readFence(sharedStateFile).epoch);
      // Known gap 1: the local cache/limiter start empty.
      assert.equal((await register(logB, b.baseUrl, signedRegisterHeaders(NONCE_ON, created, b.baseUrl))).status, 201,
        "flag off: a nonce only V1 remembers is accepted (drain must cover the signature window)");
      assert.equal((await send(logB, b.baseUrl, "/health", { headers: rateHeaders })).status, 200,
        "flag off: the local limiter does not see V1 cost");
      const offB = signedRegisterHeaders(NONCE_OFF, created, b.baseUrl);
      assert.equal((await register(logB, b.baseUrl, offB)).status, 201);
      assert.equal((await register(logB, b.baseUrl, offB)).replay, true, "local cache still rejects in-process replay");
      assert.equal(await shadowUnexplained(logB, b.baseUrl), 0);
    } finally {
      await b.close();
    }
    assertNoUnavailable("phase B (off)", logB);
    assert.equal(readFence(sharedStateFile).ownerToken, null);

    // ── Phase C: flag ON again (re-cutover) ──────────────────────────────
    const logC: PhaseLog = { statuses: [], errorCodes: [] };
    const c = await startTestServer(phase(true));
    try {
      epochs.push(readFence(sharedStateFile).epoch);
      assert.equal((await register(logC, c.baseUrl, signedRegisterHeaders(NONCE_ON, created, c.baseUrl))).replay, true,
        "V1 still holds the nonce consumed in phase A");
      assert.equal((await send(logC, c.baseUrl, "/health", { headers: rateHeaders })).status, 429,
        "V1 still holds the in-window rate cost from phase A");
      // Known gap 2: phase-B nonces never reached V1.
      assert.equal((await register(logC, c.baseUrl, signedRegisterHeaders(NONCE_OFF, created, c.baseUrl))).status, 201,
        "a nonce consumed while off is accepted once more after re-cutover");
      const freshC = signedRegisterHeaders(NONCE_FRESH, created, c.baseUrl);
      assert.equal((await register(logC, c.baseUrl, freshC)).status, 201);
      assert.equal((await register(logC, c.baseUrl, freshC)).replay, true);
      assert.equal(await shadowUnexplained(logC, c.baseUrl), 0);
    } finally {
      await c.close();
    }
    assertNoUnavailable("phase C (on)", logC);

    const final = readFence(sharedStateFile);
    assert.equal(final.ownerToken, null);
    assert.equal(final.epoch, epochs[2]);
    assert.ok(epochs[0] < epochs[1] && epochs[1] < epochs[2], `epoch strictly increases: ${epochs.join(" → ")}`);
    assert.equal(epochs[1] - epochs[0], 1n);
    assert.equal(epochs[2] - epochs[1], 1n);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
