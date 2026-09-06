/**
 * Tests for the Phase 3 serving-process fence.
 *
 * Path resolution is pure. Open/release uses temporary files only. These
 * tests do not install `/readyz`, change `/health`, or start a broker
 * unless they are checking createBrokerServer construction.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createBrokerServer } from "./server.js";
import {
  SHARED_STATE_SERVING_FENCE_V1,
  acquireSharedStateServingFenceForBrokerV1,
  openSharedStateServingFenceV1,
  resolveSharedStateServingFencePathV1,
} from "./shared-state-serving-fence-v1.js";
import {
  createInMemoryStateStore,
  startTestServer,
  withEnv,
} from "./server-test-helpers.js";

function withTempDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "a2a-serving-fence-test-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("resolves the closed fence path and treats empty as a misconfiguration", () => {
  assert.equal(
    SHARED_STATE_SERVING_FENCE_V1.envKey,
    "BROKER_SHARED_STATE_FILE",
  );
  const derived = resolveSharedStateServingFencePathV1({
    stateFile: "/var/lib/a2a-broker/state.json",
    env: {},
  });
  assert.equal(derived.ok, true);
  if (!derived.ok) throw new Error("unreachable");
  assert.equal(
    derived.value,
    "/var/lib/a2a-broker/state.json.shared-state-v1.sqlite",
  );

  const fromEnv = resolveSharedStateServingFencePathV1({
    stateFile: "/var/lib/a2a-broker/state.json",
    env: { BROKER_SHARED_STATE_FILE: "/tmp/fence.sqlite" },
  });
  assert.equal(fromEnv.ok, true);
  if (!fromEnv.ok) throw new Error("unreachable");
  assert.equal(fromEnv.value, "/tmp/fence.sqlite");

  const emptyOption = resolveSharedStateServingFencePathV1({
    stateFile: "/var/lib/a2a-broker/state.json",
    sharedStateFile: "",
    env: {},
  });
  assert.equal(emptyOption.ok, false);
  if (emptyOption.ok) throw new Error("unreachable");
  assert.equal(emptyOption.error.code, "empty_shared_state_file");

  const emptyEnv = resolveSharedStateServingFencePathV1({
    stateFile: "/var/lib/a2a-broker/state.json",
    env: { BROKER_SHARED_STATE_FILE: "" },
  });
  assert.equal(emptyEnv.ok, false);
  if (emptyEnv.ok) throw new Error("unreachable");
  assert.equal(emptyEnv.error.code, "empty_shared_state_file");
});

test("option wins over env and never uses the legacy sqlite file name", () => {
  const resolved = resolveSharedStateServingFencePathV1({
    stateFile: "/var/lib/a2a-broker/state.json",
    sharedStateFile: "/tmp/explicit-fence.sqlite",
    env: {
      BROKER_SHARED_STATE_FILE: "/tmp/env-fence.sqlite",
      SQLITE_STATE_FILE: "/tmp/legacy.sqlite",
      BROKER_SQLITE_FILE: "/tmp/legacy-too.sqlite",
    },
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) throw new Error("unreachable");
  assert.equal(resolved.value, "/tmp/explicit-fence.sqlite");
  assert.notEqual(resolved.value, "/tmp/legacy.sqlite");
  assert.notEqual(resolved.value, "/tmp/legacy-too.sqlite");
});

test("a second open on the same file fails closed until the first releases", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const first = openSharedStateServingFenceV1({ filePath });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");

    const second = openSharedStateServingFenceV1({ filePath });
    assert.equal(second.ok, false);
    if (second.ok) throw new Error("unreachable");
    assert.equal(second.error.code, "ownership_conflict");

    first.value.release();
    assert.equal(first.value.probe().ready, false);
    const third = openSharedStateServingFenceV1({ filePath });
    assert.equal(third.ok, true);
    if (!third.ok) throw new Error("unreachable");
    third.value.release();
  });
});

test("createBrokerServer acquires the fence and a second constructor on the same file fails", () => {
  withTempDir((directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    const first = createBrokerServer({
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: "https://broker.test/",
      stateStore: createInMemoryStateStore(),
      sharedStateFile,
    });
    try {
      assert.throws(
        () => createBrokerServer({
          host: "127.0.0.1",
          port: 0,
          publicBaseUrl: "https://broker.test/",
          stateStore: createInMemoryStateStore(),
          sharedStateFile,
        }),
        /shared-state serving fence rejected: ownership_conflict/,
      );
    } finally {
      first.server.close();
    }
  });
});

test("createBrokerServer releases the fence when startup fails after acquisition", () => {
  withTempDir((directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    assert.throws(
      () => createBrokerServer({
        host: "127.0.0.1",
        port: 0,
        publicBaseUrl: "https://broker.test/",
        stateStore: createInMemoryStateStore(),
        sharedStateFile,
        resultProvenanceCountersign: "enforce",
      }),
      /requires a broker signing key/,
    );

    // A failed constructor must not leave an ownership-conflict tombstone in
    // this process; a corrected retry on the same fence must succeed.
    const retry = createBrokerServer({
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: "https://broker.test/",
      stateStore: createInMemoryStateStore(),
      sharedStateFile,
    });
    retry.server.close();
  });
});

// #2051 item 5: this used to call the real
// `SHARED_STATE_SERVING_FENCE_V1.defaultLegacyStateFile`
// (`/var/lib/a2a-broker/state.json`). The behaviour under test is "the default
// state directory does not exist -> isolate the fence into a temp file", but on
// any node that actually runs a broker the directory *does* exist and is owned
// by the live process, so the test failed with `ownership_conflict` no matter
// what the change under test was (ruled out by hand during #2043 and #2044).
// The default path is now injected, so the missing-directory branch is exercised
// deterministically and the host's live broker is never touched.
test("a missing default state directory isolates the fence", () => {
  const missingDefaultStateFile = join(
    tmpdir(),
    `a2a-serving-fence-absent-${process.pid}-${Date.now()}`,
    "state.json",
  );
  assert.equal(existsSync(dirname(missingDefaultStateFile)), false);

  const fence = acquireSharedStateServingFenceForBrokerV1({
    stateFile: missingDefaultStateFile,
    defaultLegacyStateFile: missingDefaultStateFile,
    injectedStore: false,
    env: {},
  });
  fence.release();

  // The isolation branch must not have materialized the "default" directory.
  assert.equal(existsSync(dirname(missingDefaultStateFile)), false);
});

test("the real default legacy state file is still the production default", () => {
  // Guards the injection above from drifting away from what the broker uses:
  // the parameter defaults to the production constant when omitted.
  assert.equal(
    SHARED_STATE_SERVING_FENCE_V1.defaultLegacyStateFile,
    "/var/lib/a2a-broker/state.json",
  );
});

test("an injected store without an explicit fence path still constructs", async () => {
  await withEnv({ BROKER_SHARED_STATE_FILE: undefined }, async () => {
    const runtime = createBrokerServer({
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: "https://broker.test/",
      stateStore: createInMemoryStateStore(),
    });
    runtime.server.close();

    const server = await startTestServer();
    try {
      assert.equal(server.runtime.server.listening, true);
    } finally {
      await server.close();
    }
  });
});
