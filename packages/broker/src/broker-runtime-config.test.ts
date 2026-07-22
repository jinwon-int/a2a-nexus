import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BROKER_HOT_RUNTIME_LIMITS,
  resolveBrokerId,
  resolveBrokerRetentionPolicy,
  resolveHotRuntimeLimits,
  resolveIntegerOption,
  resolveStringOption,
  resolveBooleanEnv,
} from "./broker-runtime-config.js";

function withEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("resolveHotRuntimeLimits preserves explicit overrides and env fallbacks", () => {
  withEnv(
    {
      BROKER_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS: "11",
      BROKER_HOT_RUNTIME_MAX_TERMINAL_TASKS: "12",
      BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS: "13",
      BROKER_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS: "14",
      BROKER_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS: "15",
    },
    () => {
      assert.deepEqual(
        resolveHotRuntimeLimits({
          maxHotRuntimeTerminalTasks: 7,
        }),
        {
          maxNonTerminalTasks: 11,
          maxTerminalTasks: 7,
          maxAuditEvents: 13,
          maxHeartbeatAuditEvents: 14,
          maxTerminalOutboxEvents: 15,
        },
      );
    },
  );
});

test("resolveHotRuntimeLimits clamps negative values to zero", () => {
  withEnv(
    {
      BROKER_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS: "-1",
      BROKER_HOT_RUNTIME_MAX_TERMINAL_TASKS: "-2",
      BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS: "-3",
      BROKER_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS: "-4",
      BROKER_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS: "-5",
    },
    () => {
      assert.deepEqual(resolveHotRuntimeLimits({}), {
        maxNonTerminalTasks: 0,
        maxTerminalTasks: 0,
        maxAuditEvents: 0,
        maxHeartbeatAuditEvents: 0,
        maxTerminalOutboxEvents: 0,
      });
    },
  );
});

test("resolveBrokerRetentionPolicy keeps heartbeat cap default bounded by max audit override", () => {
  withEnv(
    {
      BROKER_MAX_AUDIT_EVENTS: undefined,
      BROKER_MAX_HEARTBEAT_AUDIT_EVENTS: undefined,
    },
    () => {
      const policy = resolveBrokerRetentionPolicy({ maxAuditEvents: 3 });
      assert.equal(policy.maxAuditEvents, 3);
      assert.equal(policy.maxHeartbeatAuditEvents, 3);
    },
  );
});

test("resolveBrokerRetentionPolicy derives the terminal-task byte budget from the snapshot cap (#1579)", () => {
  withEnv({ BROKER_MAX_TERMINAL_TASK_BYTES: undefined }, () => {
    // Deployment-derived fallback (half the resolved snapshot byte cap).
    const derived = resolveBrokerRetentionPolicy(undefined, { maxTerminalTaskBytes: 21 * 1024 * 1024 });
    assert.equal(derived.maxTerminalTaskBytes, 21 * 1024 * 1024);
    // Explicit override wins over the derived fallback.
    const explicit = resolveBrokerRetentionPolicy(
      { maxTerminalTaskBytes: 1024 },
      { maxTerminalTaskBytes: 21 * 1024 * 1024 },
    );
    assert.equal(explicit.maxTerminalTaskBytes, 1024);
  });
  withEnv({ BROKER_MAX_TERMINAL_TASK_BYTES: "2048" }, () => {
    // Env override wins over the derived fallback but not an explicit override.
    const fromEnv = resolveBrokerRetentionPolicy(undefined, { maxTerminalTaskBytes: 21 * 1024 * 1024 });
    assert.equal(fromEnv.maxTerminalTaskBytes, 2048);
    const explicit = resolveBrokerRetentionPolicy(
      { maxTerminalTaskBytes: 1024 },
      { maxTerminalTaskBytes: 21 * 1024 * 1024 },
    );
    assert.equal(explicit.maxTerminalTaskBytes, 1024);
  });
});

test("primitive runtime config resolvers preserve server.ts behavior", () => {
  assert.equal(resolveStringOption(" explicit ", "env", "fallback"), "explicit");
  assert.equal(resolveStringOption("", " env ", "fallback"), "env");
  assert.equal(resolveStringOption("", "", " fallback "), "fallback");
  assert.equal(resolveIntegerOption(7.9, "2", 1), 7);
  assert.equal(resolveIntegerOption(undefined, "8.4", 1), 8);
  assert.equal(resolveIntegerOption(undefined, "not-a-number", 1), 1);
  assert.equal(resolveBooleanEnv(" YES ", false), true);
  assert.equal(resolveBooleanEnv(" no ", true), false);
  assert.equal(resolveBooleanEnv("unknown", true), true);
});

test("resolveBrokerId preserves safe ids and redacts unsafe explicit/env values", () => {
  withEnv({ A2A_BROKER_ID: "env-broker", BROKER_ID: "other" }, () => {
    assert.equal(resolveBrokerId(undefined, "svc"), "env-broker");
    assert.equal(resolveBrokerId("explicit-broker", "svc"), "explicit-broker");
  });
  withEnv({ A2A_BROKER_ID: "env broker!*", BROKER_ID: "other" }, () => {
    assert.equal(resolveBrokerId(undefined, "svc"), "redacted");
    assert.equal(resolveBrokerId("explicit broker!*", "svc"), "redacted");
  });
});

test("resolveBrokerId uses BROKER_ID when A2A_BROKER_ID is unset", () => {
  withEnv({ A2A_BROKER_ID: undefined, BROKER_ID: "legacy-broker" }, () => {
    assert.equal(resolveBrokerId(undefined, "svc"), "legacy-broker");
  });
});

test("DEFAULT_BROKER_HOT_RUNTIME_LIMITS exports current server defaults", () => {
  assert.ok(DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxNonTerminalTasks > 0);
  assert.ok(DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxTerminalTasks > 0);
  assert.ok(DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxAuditEvents > 0);
  assert.ok(DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxHeartbeatAuditEvents > 0);
  assert.ok(DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxTerminalOutboxEvents > 0);
});
