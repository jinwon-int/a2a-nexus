import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JEV_TIMEOUT_DEFAULT_MS,
  JEV_TIMEOUT_MAX_MS,
  JEV_TIMEOUT_MIN_MS,
  classifyTaskWithJev,
  parseJevTimeoutMs,
  resolveJevConfig,
} from "./jev-classifier.mjs";

const INVALID_CONFIG_WARNING = "jev: classification disabled (invalid-config)";
const SYNTHETIC_ENDPOINT = "https://jev.example.invalid/api/classify";

// Synthetic, non-secret fixture key material; never a real credential.
function makeKeyfile(t, { content = "synthetic-jev-key-material", mode = 0o600 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jev-classifier-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyfilePath = join(dir, "jev.key");
  writeFileSync(keyfilePath, content);
  chmodSync(keyfilePath, mode);
  return { dir, keyfilePath };
}

function jevEnv(keyfilePath, overrides = {}) {
  return {
    A2A_JEV_CLASSIFY: "1",
    A2A_JEV_ENDPOINT: SYNTHETIC_ENDPOINT,
    A2A_JEV_KEYFILE: keyfilePath,
    ...overrides,
  };
}

function recordingTransport(resolver) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    return resolver(request, calls.length);
  };
  transport.calls = calls;
  return transport;
}

test("jev gate disable tokens match the spec set exactly and stay warning-free (#2185)", () => {
  for (const token of [undefined, "", "none", "null", "undefined", " NONE ", "Null", "  UNDEFINED  "]) {
    const config = resolveJevConfig({ A2A_JEV_CLASSIFY: token });
    assert.deepEqual(config, { enabled: false, reason: "gate-off", warnings: [] });
  }
});

test("jev gate turns on for any value outside the disable tokens (#2185)", (t) => {
  const { keyfilePath } = makeKeyfile(t);
  for (const token of ["1", "0", "true", "false", "yes", " ON "]) {
    const config = resolveJevConfig(jevEnv(keyfilePath, { A2A_JEV_CLASSIFY: token }));
    assert.equal(config.enabled, true, `token ${JSON.stringify(token)} should enable the gate`);
  }
});

test("jev invalid trio resolves disabled with exactly one value-free warning (#2185)", (t) => {
  const good = makeKeyfile(t);
  const loose = makeKeyfile(t, { mode: 0o644 });
  const cases = [
    { label: "missing endpoint", env: { A2A_JEV_CLASSIFY: "1", A2A_JEV_KEYFILE: good.keyfilePath } },
    { label: "missing keyfile path", env: { A2A_JEV_CLASSIFY: "1", A2A_JEV_ENDPOINT: SYNTHETIC_ENDPOINT } },
    { label: "empty endpoint", env: jevEnv(good.keyfilePath, { A2A_JEV_ENDPOINT: "   " }) },
    { label: "relative endpoint", env: jevEnv(good.keyfilePath, { A2A_JEV_ENDPOINT: "jev.example.invalid/api" }) },
    { label: "non-http scheme", env: jevEnv(good.keyfilePath, { A2A_JEV_ENDPOINT: "ftp://jev.example.invalid" }) },
    { label: "group/other keyfile bits", env: jevEnv(loose.keyfilePath) },
    { label: "keyfile path is a directory", env: jevEnv(good.dir) },
    { label: "keyfile path missing", env: jevEnv(join(good.dir, "does-not-exist.key")) },
  ];
  for (const { label, env } of cases) {
    const config = resolveJevConfig(env);
    assert.equal(config.enabled, false, label);
    assert.equal(config.reason, "invalid-config", label);
    assert.equal(config.warnings.length, 1, label);
    assert.equal(config.warnings[0], INVALID_CONFIG_WARNING, label);
  }
});

test("jev enabled config exposes endpoint, keyfile path, clamped timeout, and trimmed model (#2185)", (t) => {
  const { keyfilePath } = makeKeyfile(t);
  const withModel = resolveJevConfig(jevEnv(keyfilePath, {
    A2A_JEV_TIMEOUT_MS: "2600",
    A2A_JEV_MODEL: "  jev-model-x  ",
  }));
  assert.deepEqual(withModel, {
    enabled: true,
    endpoint: SYNTHETIC_ENDPOINT,
    keyfilePath,
    timeoutMs: 2600,
    model: "jev-model-x",
    warnings: [],
  });
  const withoutModel = resolveJevConfig(jevEnv(keyfilePath));
  assert.equal(withoutModel.enabled, true);
  assert.equal(withoutModel.model, null);
  assert.equal(withoutModel.timeoutMs, JEV_TIMEOUT_DEFAULT_MS);
  assert.deepEqual(withoutModel.warnings, []);
});

test("parseJevTimeoutMs defaults on unusable input and clamps into the spec window (#2185)", () => {
  for (const raw of [undefined, null, "", "   ", "abc", "NaN"]) {
    assert.equal(parseJevTimeoutMs(raw), JEV_TIMEOUT_DEFAULT_MS, `input ${JSON.stringify(raw)}`);
  }
  assert.equal(parseJevTimeoutMs("100"), JEV_TIMEOUT_MIN_MS);
  assert.equal(parseJevTimeoutMs("0"), JEV_TIMEOUT_MIN_MS);
  assert.equal(parseJevTimeoutMs("-50"), JEV_TIMEOUT_MIN_MS);
  assert.equal(parseJevTimeoutMs("99999"), JEV_TIMEOUT_MAX_MS);
  assert.equal(parseJevTimeoutMs("250"), JEV_TIMEOUT_MIN_MS);
  assert.equal(parseJevTimeoutMs("5000"), JEV_TIMEOUT_MAX_MS);
  assert.equal(parseJevTimeoutMs(" 1500 "), 1500);
});

test("classifyTaskWithJev short-circuits disabled configs and task-less probes without transport (#2185)", async (t) => {
  const { keyfilePath } = makeKeyfile(t);
  const transport = recordingTransport(() => {
    throw new Error("transport must not be called for short-circuit outcomes");
  });
  assert.deepEqual(await classifyTaskWithJev({ message: "x" }, null, { transport }), {
    ok: false,
    reason: "disabled",
    attempts: 0,
  });
  assert.deepEqual(await classifyTaskWithJev({ message: "x" }, { enabled: false }, { transport }), {
    ok: false,
    reason: "disabled",
    attempts: 0,
  });
  const config = resolveJevConfig(jevEnv(keyfilePath));
  assert.deepEqual(await classifyTaskWithJev({}, config, { transport }), {
    ok: false,
    reason: "invalid-task",
    attempts: 0,
  });
  assert.deepEqual(await classifyTaskWithJev({ message: "   ", prompt: "  " }, config, { transport }), {
    ok: false,
    reason: "invalid-task",
    attempts: 0,
  });
  assert.equal(transport.calls.length, 0);
  // message takes precedence; whitespace-only message falls back to prompt.
  const transportForPrompt = recordingTransport(() => ({ status: 200, text: '{"is_real_work":true}' }));
  const fromPrompt = await classifyTaskWithJev({ message: "  ", prompt: "probe from prompt" }, config, { transport: transportForPrompt });
  assert.equal(fromPrompt.ok, true);
  assert.equal(transportForPrompt.calls[0].payload.description, "probe from prompt");
});

test("classifyTaskWithJev accepts boolean verdicts with exactly one transport call (#2185)", async (t) => {
  const { keyfilePath } = makeKeyfile(t);
  const config = resolveJevConfig(jevEnv(keyfilePath, { A2A_JEV_TIMEOUT_MS: "2600", A2A_JEV_MODEL: " jev-model-x " }));
  for (const verdict of [true, false]) {
    const transport = recordingTransport(() => ({ status: 200, text: JSON.stringify({ is_real_work: verdict }) }));
    const result = await classifyTaskWithJev({ message: "fix the flaky retry path", intent: "bug_fix" }, config, { transport });
    assert.deepEqual(result, { ok: true, isRealWork: verdict, attempts: 1 });
    assert.equal(transport.calls.length, 1);
    const request = transport.calls[0];
    assert.equal(request.endpoint, SYNTHETIC_ENDPOINT);
    assert.equal(request.key, "synthetic-jev-key-material");
    assert.equal(request.timeoutMs, 2600);
    assert.equal(request.payload.description, "fix the flaky retry path");
    assert.equal(request.payload.intent, "bug_fix");
    assert.equal(request.payload.model, "jev-model-x");
  }
});

test("classifyTaskWithJev falls back per failure class without retrying (#2185)", async (t) => {
  const { keyfilePath } = makeKeyfile(t);
  const config = resolveJevConfig(jevEnv(keyfilePath));
  const task = { message: "synthetic probe task" };
  const cases = [
    {
      label: "non-JSON body",
      resolver: () => ({ status: 200, text: "not json at all" }),
      expected: { ok: false, reason: "invalid-verdict", attempts: 1 },
    },
    {
      label: "array verdict",
      resolver: () => ({ status: 200, text: '["is_real_work",true]' }),
      expected: { ok: false, reason: "invalid-verdict", attempts: 1 },
    },
    {
      label: "null verdict",
      resolver: () => ({ status: 200, text: "null" }),
      expected: { ok: false, reason: "invalid-verdict", attempts: 1 },
    },
    {
      label: "non-boolean is_real_work",
      resolver: () => ({ status: 200, text: '{"is_real_work":"yes"}' }),
      expected: { ok: false, reason: "invalid-verdict", attempts: 1 },
    },
    {
      label: "http error keeps status",
      resolver: () => ({ status: 503, text: "unavailable" }),
      expected: { ok: false, reason: "http-error", status: 503, attempts: 1 },
    },
    {
      label: "thrown error is transport-error",
      resolver: () => {
        throw new Error("synthetic socket failure");
      },
      expected: { ok: false, reason: "transport-error", attempts: 1 },
    },
    {
      label: "TimeoutError name maps to timeout",
      resolver: () => {
        const error = new Error("synthetic timeout");
        error.name = "TimeoutError";
        throw error;
      },
      expected: { ok: false, reason: "timeout", attempts: 1 },
    },
    {
      label: "AbortError name maps to timeout",
      resolver: () => {
        const error = new Error("synthetic abort");
        error.name = "AbortError";
        throw error;
      },
      expected: { ok: false, reason: "timeout", attempts: 1 },
    },
    {
      label: "missing response is transport-error",
      resolver: () => undefined,
      expected: { ok: false, reason: "transport-error", attempts: 1 },
    },
    {
      label: "non-numeric status is transport-error",
      resolver: () => ({ status: "200", text: "{}" }),
      expected: { ok: false, reason: "transport-error", attempts: 1 },
    },
  ];
  for (const { label, resolver, expected } of cases) {
    const transport = recordingTransport(resolver);
    const result = await classifyTaskWithJev(task, config, { transport });
    assert.deepEqual(result, expected, label);
    assert.equal(transport.calls.length, 1, `${label}: exactly one attempt, no retry`);
  }
});

test("classifyTaskWithJev reads the keyfile at call time (#2185)", async (t) => {
  const { keyfilePath } = makeKeyfile(t, { content: "synthetic-key-before-rotate" });
  const config = resolveJevConfig(jevEnv(keyfilePath));
  const transport = recordingTransport(() => ({ status: 200, text: '{"is_real_work":true}' }));
  const before = await classifyTaskWithJev({ message: "probe" }, config, { transport });
  assert.equal(before.ok, true);
  assert.equal(transport.calls[0].key, "synthetic-key-before-rotate");
  writeFileSync(keyfilePath, "synthetic-key-after-rotate");
  chmodSync(keyfilePath, 0o600);
  const after = await classifyTaskWithJev({ message: "probe" }, config, { transport });
  assert.equal(after.ok, true);
  assert.equal(transport.calls[1].key, "synthetic-key-after-rotate");
});

test("classifyTaskWithJev reports keyfile-unreadable without calling transport (#2185)", async (t) => {
  const { dir, keyfilePath } = makeKeyfile(t);
  const config = resolveJevConfig(jevEnv(keyfilePath));
  assert.equal(config.enabled, true);
  rmSync(keyfilePath);
  const transport = recordingTransport(() => ({ status: 200, text: '{"is_real_work":true}' }));
  const deleted = await classifyTaskWithJev({ message: "probe" }, config, { transport });
  assert.deepEqual(deleted, { ok: false, reason: "keyfile-unreadable", attempts: 0 });
  assert.equal(transport.calls.length, 0);
  // A whitespace-only keyfile yields no key material and stays unreadable.
  const blankPath = join(dir, "blank.key");
  writeFileSync(blankPath, "   \n");
  chmodSync(blankPath, 0o600);
  const blankConfig = resolveJevConfig(jevEnv(blankPath));
  const blank = await classifyTaskWithJev({ message: "probe" }, blankConfig, { transport });
  assert.deepEqual(blank, { ok: false, reason: "keyfile-unreadable", attempts: 0 });
  assert.equal(transport.calls.length, 0);
  // The stat shape behind the resolve-time owner-only check stays a regular file.
  assert.equal(statSync(blankPath).isFile(), true);
});

// --- G1 typed-verdict contract (docs/specs/jev-review-evidence-shadow/) ---

import { classifyTypedWithJev, normalizeTypedQuestions } from "./jev-classifier.mjs";

const TYPED_QUESTIONS = [
  { id: "receipt_state", type: "choice", instructions: "Receipt state for the projected sources.", labels: ["complete", "partial", "unreadable", "insufficient_information", "defer"] },
  { id: "p_source_sufficient", type: "noul", instructions: "Probability that the projected sources are sufficient." },
  { id: "receipt_fidelity", type: "score", instructions: "Carrier/projection fidelity score." },
];

test("G1 normalizeTypedQuestions builds the wire map without labels and rejects malformed input", () => {
  const ok = normalizeTypedQuestions(TYPED_QUESTIONS);
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.wire), ["receipt_state", "p_source_sufficient", "receipt_fidelity"]);
  assert.deepEqual(ok.wire.receipt_state, { type: "choice", instructions: TYPED_QUESTIONS[0].instructions });
  assert.equal(normalizeTypedQuestions([]).ok, false);
  assert.equal(normalizeTypedQuestions([{ id: "a", type: "noul", instructions: "x" }, { id: "a", type: "noul", instructions: "y" }]).ok, false);
  assert.equal(normalizeTypedQuestions([{ id: "a", type: "choice", instructions: "x" }]).ok, false, "choice requires labels");
  assert.equal(normalizeTypedQuestions([{ id: "a", type: "noul" }]).ok, false, "instructions required");
  assert.equal(normalizeTypedQuestions([{ id: "a", type: "quantum", instructions: "x" }]).ok, false, "unknown type rejected");
});

test("G1 resolveJevConfig honors an alternate gate variable with unchanged trio semantics", () => {
  const config = resolveJevConfig({ A2A_JEV_RECEIPT_SHADOW: "1", A2A_JEV_ENDPOINT: SYNTHETIC_ENDPOINT, A2A_JEV_KEYFILE: "/nonexistent" }, "A2A_JEV_RECEIPT_SHADOW");
  assert.equal(config.enabled, false, "unreadable keyfile disables");
  const probeOnly = resolveJevConfig({ A2A_JEV_CLASSIFY: "1", A2A_JEV_ENDPOINT: SYNTHETIC_ENDPOINT, A2A_JEV_KEYFILE: "/nonexistent" }, "A2A_JEV_RECEIPT_SHADOW");
  assert.equal(probeOnly.enabled, false, "probe gate must not enable the receipt shadow");
});

test("G1 classifyTypedWithJev happy path: one attempt, normalized typed answers, labels never on the wire", async (t) => {
  const { keyfilePath } = makeKeyfile(t);
  const transport = recordingTransport(() => ({
    status: 200,
    text: JSON.stringify({
      answers: {
        receipt_state: { choice: "complete", confidence: 0.82 },
        p_source_sufficient: { noul: 0.91 },
        receipt_fidelity: { score: 2.4, confidence: 0.6 },
      },
      model: "jev-latest",
    }),
  }));
  const result = await classifyTypedWithJev({
    config: { enabled: true, endpoint: SYNTHETIC_ENDPOINT, keyfilePath, timeoutMs: 1500, model: "jev-latest" },
    state: "banded judgment-time state",
    questions: TYPED_QUESTIONS,
    transport,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.answers.receipt_state, { type: "choice", label: "complete", confidence: 0.82 });
  assert.deepEqual(result.answers.p_source_sufficient, { type: "noul", probability: 0.91 });
  assert.deepEqual(result.answers.receipt_fidelity, { type: "score", value: 2.4, confidence: 0.6 });
  assert.equal(result.model, "jev-latest");
  assert.equal(transport.calls.length, 1, "exactly one attempt, no retry");
  const payload = transport.calls[0].payload;
  assert.equal(payload.state, "banded judgment-time state");
  assert.equal(payload.model, "jev-latest");
  assert.equal(JSON.stringify(payload).includes("labels"), false, "closed label sets never leave the process");
});

test("G1 classifyTypedWithJev invalid verdicts: missing id, wrong shape, out of range, bad JSON", async (t) => {
  const { keyfilePath } = makeKeyfile(t);
  const config = { enabled: true, endpoint: SYNTHETIC_ENDPOINT, keyfilePath, timeoutMs: 1500 };
  const cases = [
    { answers: { receipt_state: { choice: "complete" } }, why: "missing requested ids" },
    { answers: { receipt_state: { noul: 0.5 }, p_source_sufficient: { noul: 0.5 }, receipt_fidelity: { noul: 0.5 } }, why: "score answered as noul" },
    { answers: { receipt_state: { choice: "banana" }, p_source_sufficient: { noul: 0.5 }, receipt_fidelity: { score: 1 } }, why: "choice label outside the closed set" },
    { answers: { receipt_state: { choice: "complete" }, p_source_sufficient: { noul: 1.7 }, receipt_fidelity: { score: 1 } }, why: "noul out of range" },
    { answers: { receipt_state: { choice: "complete", confidence: 3 }, p_source_sufficient: { noul: 0.5 }, receipt_fidelity: { score: 1 } }, why: "confidence out of range" },
    { answers: "not-an-object", why: "answers not an object" },
  ];
  for (const { answers, why } of cases) {
    const transport = recordingTransport(() => ({ status: 200, text: JSON.stringify({ answers }) }));
    const result = await classifyTypedWithJev({ config, state: "s", questions: TYPED_QUESTIONS, transport });
    assert.equal(result.ok, false, why);
    assert.equal(result.reason, "invalid-verdict", why);
    assert.equal(result.attempts, 1, why);
    assert.equal(transport.calls.length, 1, why);
  }
  const badJson = recordingTransport(() => ({ status: 200, text: "{nope" }));
  const badJsonResult = await classifyTypedWithJev({ config, state: "s", questions: TYPED_QUESTIONS, transport: badJson });
  assert.equal(badJsonResult.reason, "invalid-verdict");
});

test("G1 classifyTypedWithJev failure discipline mirrors the boolean contract", async (t) => {
  const { keyfilePath, dir } = makeKeyfile(t);
  const config = { enabled: true, endpoint: SYNTHETIC_ENDPOINT, keyfilePath, timeoutMs: 1500 };
  assert.equal((await classifyTypedWithJev({ config: { enabled: false }, state: "s", questions: TYPED_QUESTIONS })).reason, "disabled");
  assert.equal((await classifyTypedWithJev({ config, state: "   ", questions: TYPED_QUESTIONS })).reason, "invalid-state");
  assert.equal((await classifyTypedWithJev({ config, state: "s", questions: [] })).reason, "invalid-questions");
  const unreadableConfig = { ...config, keyfilePath: join(dir, "missing.key") };
  assert.equal((await classifyTypedWithJev({ config: unreadableConfig, state: "s", questions: TYPED_QUESTIONS })).reason, "keyfile-unreadable");

  const timeoutTransport = recordingTransport(() => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
  assert.equal((await classifyTypedWithJev({ config, state: "s", questions: TYPED_QUESTIONS, transport: timeoutTransport })).reason, "timeout");

  const refusedTransport = recordingTransport(() => { throw new Error("ECONNREFUSED"); });
  assert.equal((await classifyTypedWithJev({ config, state: "s", questions: TYPED_QUESTIONS, transport: refusedTransport })).reason, "transport-error");

  const httpTransport = recordingTransport(() => ({ status: 503, text: "" }));
  assert.equal((await classifyTypedWithJev({ config, state: "s", questions: TYPED_QUESTIONS, transport: httpTransport })).reason, "http-error");
});
