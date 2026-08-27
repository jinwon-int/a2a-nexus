import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import { resolveWavePlanDagV2Mode } from "../core/wave-plan-dag-v2-mode.js";
import {
  handleWavePlanDagV2RoutesIfMatched,
} from "./wave-plan-dag-v2-routes.js";
import { createWavePlanDagV2RecordStore, wavePlanDagV2ManifestAdmissionEntry } from "../wave-plan-dag-v2/record-store.js";
import { admitWavePlanDagManifestV2 } from "../wave-plan-dag-v2/manifest.js";
import { BrokerError } from "../core/broker-error.js";

/**
 * #1800 slice 5 — broker wiring + read-only routes.
 *
 * Load-bearing rules:
 * - mode gate: `off` keeps every surface absent; invalid env values fail
 *   loudly (same posture as review-lineage).
 * - store/requires-mode consistency: a store without `record` throws.
 * - the single write entry point records boundary-classified evidence and
 *   NEVER runs automatically; v1 payloads pass through untouched.
 * - routes are GET-only under an independent prefix, disjoint from v1
 *   `/wave-plans*`; responses carry only closed stored entries + counters.
 */

const FIXTURE = JSON.parse(
  readFileSync(
    join(process.cwd(), "..", "..", "fixtures", "contract", "wave-plan-dag-v2.json"),
    "utf8",
  ),
) as { manifest: Record<string, unknown>; dryRuns: Array<{ request: Record<string, unknown> }> };

interface CapturedResponse {
  res: import("node:http").ServerResponse;
  status(): number | undefined;
  body(): string;
}

function captureResponse(): CapturedResponse {
  let body = "";
  let status: number | undefined;
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    setHeader() {},
    end(chunk?: string | Uint8Array) {
      if (chunk !== undefined) body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      else if (body === "") body = ""; // end() without payload after write() calls
    },
    write(chunk?: string | Uint8Array) {
      if (chunk !== undefined) body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as unknown as import("node:http").ServerResponse & { __get: () => { body: string; status: number | undefined } };
  (res as unknown as { __get: () => { body: string; status: number | undefined } }).__get = () => ({ body, status });
  return {
    res,
    status: () => status,
    body: () => (res as unknown as { __get: () => { body: string; status: number | undefined } }).__get().body,
  };
}

test("mode resolution mirrors the review-lineage posture", () => {
  assert.equal(resolveWavePlanDagV2Mode(undefined), "off");
  assert.equal(resolveWavePlanDagV2Mode(""), "off");
  assert.equal(resolveWavePlanDagV2Mode("off"), "off");
  assert.equal(resolveWavePlanDagV2Mode("record"), "record");
  assert.throws(() => resolveWavePlanDagV2Mode("enforce"), /invalid A2A_WAVE_PLAN_DAG_V2_MODE/);
});

test("broker defaults to off and surfaces nothing even when asked", () => {
  const broker = new InMemoryA2ABroker();
  const diagnostics = broker.wavePlanDagV2RecordDiagnostics();
  assert.equal(diagnostics.mode, "off");
  assert.equal(diagnostics.enabled, false);
  assert.equal(broker.recordWavePlanDagV2Intake(structuredClone(FIXTURE.manifest)), undefined);
  assert.deepEqual(broker.listWavePlanDagV2Admissions(), []);
  assert.deepEqual(broker.listWavePlanDagV2Rehearsals("sha256:x"), []);
});

test("a store without record mode is a constructor error (consistency)", () => {
  assert.throws(
    () => new InMemoryA2ABroker(undefined, undefined, {
      wavePlanDagV2Mode: "off",
      wavePlanDagV2RecordStore: createWavePlanDagV2RecordStore(),
    }),
    /requires wavePlanDagV2Mode 'record'/,
  );
});

test("record mode records boundary-classified evidence via the single entry point", () => {
  const store = createWavePlanDagV2RecordStore();
  const broker = new InMemoryA2ABroker(undefined, undefined, { wavePlanDagV2Mode: "record", wavePlanDagV2RecordStore: store });

  // V1 payload: pass-through skip, nothing recorded.
  const v1Result = broker.recordWavePlanDagV2Intake({ wavePlanId: "w1", stages: [{ id: "s", gate: { type: "manual" } }] });
  assert.equal(v1Result, undefined);

  // V2 golden pair.
  const result = broker.recordWavePlanDagV2Intake(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  assert.ok(Array.isArray(result) && result.length === 2);

  // Idempotent replay from the same source collapses in-store.
  broker.recordWavePlanDagV2Intake(structuredClone(FIXTURE.manifest), structuredClone(FIXTURE.dryRuns[0].request));
  const diagnostics = broker.wavePlanDagV2RecordDiagnostics();
  assert.equal(diagnostics.mode, "record");
  assert.equal(diagnostics.enabled, true);
  assert.equal(diagnostics.appends, 2);
  assert.equal(diagnostics.duplicates, 2);
  assert.equal(diagnostics.skipped, 1);
  assert.equal(broker.listWavePlanDagV2Admissions().length, 1);
});

test("rejected V2 payloads land in operator diagnostics, never as store rows", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { wavePlanDagV2Mode: "record" });
  const broken = { ...structuredClone(FIXTURE.manifest), prompt: "forbidden" };

  const result = broker.recordWavePlanDagV2Intake(broken);
  assert.equal(result, undefined, "no admitted manifest exists, so nothing is stored");

  const diagnostics = broker.wavePlanDagV2RecordDiagnostics();
  assert.equal(diagnostics.rejected, 1);
  assert.match(diagnostics.lastSkipReason ?? "", /manifest_rejected:manifest_malformed/);
  assert.deepEqual(broker.listWavePlanDagV2Admissions(), []);
  assert.deepEqual(broker.listWavePlanDagV2Rehearsals("sha256:" + "0".repeat(64)), []);

  // A later legitimate admission of the same (now fixed) payload still works.
  const recovered = broker.recordWavePlanDagV2Intake(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  assert.ok(Array.isArray(recovered) && recovered.length === 2);
  assert.equal(broker.listWavePlanDagV2Admissions().length, 1);
});

test("admission+store-constructed helper entries stay consistent with slice-4 stores", () => {
  const admitted = admitWavePlanDagManifestV2(structuredClone(FIXTURE.manifest));
  assert.ok(admitted.ok);
  if (!admitted.ok) return;
  const entry = wavePlanDagV2ManifestAdmissionEntry(admitted);
  const store = createWavePlanDagV2RecordStore();
  const appended = store.append([entry]);
  assert.ok(appended.ok && appended.committed === 1);
});

function routeContext(broker: InMemoryA2ABroker, method: string, path: string, search = "") {
  return {
    ctx: {
      method,
      path,
      req: {} as import("node:http").IncomingMessage,
      res: null as unknown as import("node:http").ServerResponse,
      broker,
      enforceRequesterIdentity: false,
      requesterIdentity: null,
    },
    url: new URL(`http://broker.test${path}${search}`),
  };
}

test("routes serve closed listings only under the independent prefix", async () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { wavePlanDagV2Mode: "record" });
  broker.recordWavePlanDagV2Intake(structuredClone(FIXTURE.manifest));

  const admissionsRequest = routeContext(broker, "GET", "/wave-plan-dag-v2/admissions");
  const captured = captureResponse();
  const res = captured.res;
  admissionsRequest.ctx.res = res;
  const handled = await handleWavePlanDagV2RoutesIfMatched(admissionsRequest.ctx, admissionsRequest.url);
  assert.equal(handled, true);

  const parsed = JSON.parse(captured.body());
  assert.equal(parsed.kind, "wave-plan-dag-v2-admissions");
  assert.equal(parsed.mode, "record");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.admissions[0].manifestDigest, FIXTURE.manifest.manifestDigest);
  assert.equal(parsed.admissions[0].stageCount, 8);
  const encoded = captured.body();
  assert.ok(
    !encoded.includes("stg_00000000") && !encoded.includes("topologicalOrder"),
    "listings must not leak rehearsal internals",
  );
  assert.equal(encoded.includes('"stageCount":8'), true);
});

test("rehearsals endpoint validates its query parameter fail-closed", async () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { wavePlanDagV2Mode: "record" });
  broker.recordWavePlanDagV2Intake(structuredClone(FIXTURE.manifest), structuredClone(FIXTURE.dryRuns[0].request));
  const digest = FIXTURE.manifest.manifestDigest as string;

  const good = routeContext(broker, "GET", "/wave-plan-dag-v2/rehearsals", `?manifestDigest=${digest}`);
  const goodRes = captureResponse();
  good.ctx.res = goodRes.res;
  assert.equal(await handleWavePlanDagV2RoutesIfMatched(good.ctx, good.url), true);
  const parsed = JSON.parse(goodRes.body());
  assert.equal(parsed.kind, "wave-plan-dag-v2-rehearsals");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.rehearsals[0].entryType, "rehearsal_receipt_recorded");
  assert.equal(parsed.rehearsals[0].manifestDigest, digest);

  // Unknown digest answers an empty total list, not a 404.
  const empty = routeContext(broker, "GET", "/wave-plan-dag-v2/rehearsals", `?manifestDigest=sha256:${"9".repeat(64)}`);
  const emptyRes = captureResponse();
  empty.ctx.res = emptyRes.res;
  assert.equal(await handleWavePlanDagV2RoutesIfMatched(empty.ctx, empty.url), true);
  assert.equal(JSON.parse(emptyRes.body()).count, 0);

  const badQuery = routeContext(broker, "GET", "/wave-plan-dag-v2/rehearsals", "?manifestDigest=notadigest");
  await assert.rejects(
    () => handleWavePlanDagV2RoutesIfMatched(badQuery.ctx, badQuery.url),
    (error) => error instanceof BrokerError && error.code === "bad_request",
  );
});

test("non-GET methods are refused on the read-only surface", async () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { wavePlanDagV2Mode: "record" });
  const post = routeContext(broker, "POST", "/wave-plan-dag-v2/admissions");
  await assert.rejects(
    () => handleWavePlanDagV2RoutesIfMatched(post.ctx, post.url),
    (error) => error instanceof BrokerError && /read-only/.test(error.message),
  );
});

test("unrelated paths fall through untouched; other prefixes unaffected", async () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { wavePlanDagV2Mode: "record" });
  for (const path of ["/wave-plans", "/wave-plans/abc", "/review-lineages", "/health"]) {
    const fallthrough = routeContext(broker, "GET", path);
    assert.equal(await handleWavePlanDagV2RoutesIfMatched(fallthrough.ctx, fallthrough.url), false, path);
  }
});
