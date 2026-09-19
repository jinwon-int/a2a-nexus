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
