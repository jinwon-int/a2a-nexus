/**
 * Tests for the Gateway config bridge — safe operatorEvents/notification
 * config injection with backup → apply → verify → rollback-on-fail.
 *
 * Issue:  jinwon-int/openclaw-plugin-a2a#269
 * Parent: jinwon-int/a2a-plane#241
 * Run:    terminal-brief-activation-20260511T080211Z
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createGatewayConfigBackup,
  restoreGatewayConfigFromBackup,
  applyGatewayConfigBridge,
  diffGatewayConfigs,
  validateConfigBridgeApplication,
  applyGatewayConfigBridgeSafe,
  buildOperatorNotificationConfigTemplate,
  buildOperatorEventsOnlyTemplate,
  buildTerminalOutboxLiveCanaryConfigTemplate,
  isOperatorEventsConfigInternallyConsistent,
  validateOperatorEventsLiveConfigShape,
} from "../dist/src/gateway-config-bridge.js";

// ── Fixtures ────────────────────────────────────────────────────────

function baseConfig(overrides) {
  const cfg = { baseUrl: "https://broker.example.com", requester: { id: "session:requester", kind: "session", role: "hub" }, ...overrides };
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: cfg,
        },
      },
    },
  };
}

function configWithoutPluginEntry() {
  return {
    plugins: {
      entries: {},
    },
  };
}

function configWithPluginDisabled() {
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: false,
          config: {},
        },
      },
    },
  };
}

// ── Backup / Restore ────────────────────────────────────────────────

test("createGatewayConfigBackup captures plugin entry state", () => {
  const cfg = baseConfig({
    operatorEvents: { enabled: true, notification: { enabled: false, channel: "telegram" } },
  });
  const backup = createGatewayConfigBackup(cfg, () => 1715000000000);

  assert.ok(backup.entry, "backup must have entry config");
  assert.equal(backup.enabled, true);
  assert.equal(backup.takenAt, 1715000000000);

  /** @type {Record<string, unknown>} */
  const entry = backup.entry;
  const oe = /** @type {Record<string, unknown>} */ (entry.operatorEvents);
  assert.equal(oe.enabled, true);
  assert.equal(/** @type {Record<string, unknown>} */ (oe.notification).enabled, false);
});

test("createGatewayConfigBackup returns undefined entry when plugin absent", () => {
  const backup = createGatewayConfigBackup(configWithoutPluginEntry(), () => 1715000000000);
  assert.equal(backup.entry, undefined);
  assert.equal(backup.enabled, undefined);
});

test("restoreGatewayConfigFromBackup restores exact pre-snapshot state", () => {
  const cfg = baseConfig({
    operatorEvents: { enabled: true, notification: { enabled: true, channel: "telegram", to: "operator-chat" } },
    baseUrl: "https://broker.example.com",
  });
  const backup = createGatewayConfigBackup(cfg);

  // Mutate config
  /** @type {Record<string, unknown>} */
  const pluginCfg = cfg.plugins.entries["a2a-broker-adapter"].config;
  const oe = /** @type {Record<string, unknown>} */ (pluginCfg.operatorEvents);
  oe.enabled = false;
  /** @type {Record<string, unknown>} */ (oe.notification).enabled = false;
  /** @type {Record<string, unknown>} */ (oe.notification).to = "changed";

  // Restore
  restoreGatewayConfigFromBackup(cfg, backup);

  const restored = /** @type {Record<string, unknown>} */ (cfg.plugins.entries["a2a-broker-adapter"].config);
  const restoredOe = /** @type {Record<string, unknown>} */ (restored.operatorEvents);
  assert.equal(restoredOe.enabled, true);
  assert.equal(/** @type {Record<string, unknown>} */ (restoredOe.notification).enabled, true);
  assert.equal(/** @type {Record<string, unknown>} */ (restoredOe.notification).to, "operator-chat");
  assert.equal(restored.baseUrl, "https://broker.example.com");
});

test("restoreGatewayConfigFromBackup removes entry when backup had none", () => {
  const cfg = baseConfig();
  const backup = { entry: undefined, enabled: undefined, takenAt: 1715000000000 };

  restoreGatewayConfigFromBackup(cfg, backup);
  assert.equal(cfg.plugins.entries["a2a-broker-adapter"], undefined);
});

// ── Apply ───────────────────────────────────────────────────────────

test("applyGatewayConfigBridge creates operatorEvents block when absent", () => {
  const cfg = baseConfig({ baseUrl: "https://broker.example.com" });
  applyGatewayConfigBridge(cfg, buildOperatorNotificationConfigTemplate("telegram", "operator-chat"));

  /** @type {Record<string, unknown>} */
  const pluginCfg = cfg.plugins.entries["a2a-broker-adapter"].config;
  const oe = /** @type {Record<string, unknown>} */ (pluginCfg.operatorEvents);
  assert.equal(oe.enabled, true);
  const notif = /** @type {Record<string, unknown>} */ (oe.notification);
  assert.equal(notif.enabled, true);
  assert.equal(notif.channel, "telegram");
  assert.equal(notif.to, "operator-chat");
});

test("applyGatewayConfigBridge preserves existing config fields", () => {
  const cfg = baseConfig({
    baseUrl: "https://broker.example.com",
    operatorEvents: { enabled: true },
  });
  applyGatewayConfigBridge(cfg, {
    operatorEventsEnabled: true,
    notificationEnabled: true,
    notificationChannel: "telegram",
    notificationTo: "operator-chat",
  });

  /** @type {Record<string, unknown>} */
  const pluginCfg = cfg.plugins.entries["a2a-broker-adapter"].config;
  assert.equal(pluginCfg.baseUrl, "https://broker.example.com");
  const oe = /** @type {Record<string, unknown>} */ (pluginCfg.operatorEvents);
  assert.equal(oe.enabled, true);
  const notif = /** @type {Record<string, unknown>} */ (oe.notification);
  assert.equal(notif.enabled, true);
  assert.equal(notif.channel, "telegram");
  assert.equal(notif.to, "operator-chat");
});

test("applyGatewayConfigBridge creates plugin entry when absent", () => {
  const cfg = configWithoutPluginEntry();
  applyGatewayConfigBridge(cfg, buildOperatorNotificationConfigTemplate("telegram", "operator-chat"));

  const entry = cfg.plugins.entries["a2a-broker-adapter"];
  assert.ok(entry, "plugin entry must be created");
  assert.equal(entry.enabled, true);
  /** @type {Record<string, unknown>} */
  const pluginCfg = entry.config;
  const oe = /** @type {Record<string, unknown>} */ (pluginCfg.operatorEvents);
  assert.equal(oe.enabled, true);
});

test("applyGatewayConfigBridge sets notification to disabled explicitly", () => {
  const cfg = baseConfig();
  applyGatewayConfigBridge(cfg, buildOperatorEventsOnlyTemplate());

  /** @type {Record<string, unknown>} */
  const pluginCfg = cfg.plugins.entries["a2a-broker-adapter"].config;
  const oe = /** @type {Record<string, unknown>} */ (pluginCfg.operatorEvents);
  assert.equal(oe.enabled, true);
  const notif = /** @type {Record<string, unknown>} */ (oe.notification);
  assert.equal(notif.enabled, false);
});

test("applyGatewayConfigBridge includes accountId and threadId when provided", () => {
  const cfg = baseConfig();
  applyGatewayConfigBridge(cfg, {
    operatorEventsEnabled: true,
    notificationEnabled: true,
    notificationChannel: "telegram",
    notificationTo: "operator-chat",
    notificationAccountId: "account-1",
    notificationThreadId: 456,
  });

  /** @type {Record<string, unknown>} */
  const pluginCfg = cfg.plugins.entries["a2a-broker-adapter"].config;
  const oe = /** @type {Record<string, unknown>} */ (pluginCfg.operatorEvents);
  const notif = /** @type {Record<string, unknown>} */ (oe.notification);
  assert.equal(notif.accountId, "account-1");
  assert.equal(notif.threadId, 456);
});

test("applyGatewayConfigBridge includes bounded terminal-outbox canary fields", () => {
  const cfg = baseConfig();
  applyGatewayConfigBridge(cfg, buildTerminalOutboxLiveCanaryConfigTemplate({
    channel: "telegram",
    to: "telegram:operator-chat",
    accountId: "default",
    cursor: "terminal:previous:succeeded:2026-05-17T00%3A00%3A00.000Z",
    allowedIds: ["terminal:fresh-canary"],
  }));

  /** @type {Record<string, unknown>} */
  const pluginCfg = cfg.plugins.entries["a2a-broker-adapter"].config;
  const oe = /** @type {Record<string, unknown>} */ (pluginCfg.operatorEvents);
  assert.equal(oe.enabled, true);
  assert.equal(oe.terminalOutboxCursor, "terminal:previous:succeeded:2026-05-17T00%3A00%3A00.000Z");
  assert.deepEqual(oe.terminalOutboxAllowedIds, ["terminal:fresh-canary"]);
  assert.equal(oe.terminalOutboxReconcileUnackedOnStart, false);
  const notif = /** @type {Record<string, unknown>} */ (oe.notification);
  assert.equal(notif.enabled, true);
  assert.equal(notif.channel, "telegram");
  assert.equal(notif.to, "telegram:operator-chat");
  assert.equal(notif.accountId, "default");
});

// ── Diff ────────────────────────────────────────────────────────────

test("diffGatewayConfigs detects operatorEvents.enabled change", () => {
  const before = baseConfig();
  const after = baseConfig({
    operatorEvents: { enabled: true },
  });

  const backup = createGatewayConfigBackup(before);
  const diff = diffGatewayConfigs(backup, after);

  assert.ok(diff.some((line) => line.includes("operatorEvents.enabled")), "diff must include operatorEvents.enabled change");
});

test("diffGatewayConfigs detects notification block changes", () => {
  const cfg = baseConfig({
    operatorEvents: { enabled: true },
  });
  const backup = createGatewayConfigBackup(cfg);

  applyGatewayConfigBridge(cfg, buildOperatorNotificationConfigTemplate("telegram", "operator-chat"));
  const diff = diffGatewayConfigs(backup, cfg);

  assert.ok(diff.some((line) => line.includes("operatorEvents.notification.enabled")), "diff must include notification.enabled change");
  assert.ok(diff.some((line) => line.includes("operatorEvents.notification.channel")), "diff must include notification.channel change");
  assert.ok(diff.some((line) => line.includes("operatorEvents.notification.to")), "diff must include notification.to change");
});

test("diffGatewayConfigs detects terminal-outbox canary boundary changes", () => {
  const cfg = baseConfig();
  const backup = createGatewayConfigBackup(cfg);

  applyGatewayConfigBridge(cfg, buildTerminalOutboxLiveCanaryConfigTemplate({
    channel: "telegram",
    to: "telegram:operator-chat",
    cursor: "terminal:previous:succeeded:2026-05-17T00%3A00%3A00.000Z",
    allowedIds: ["terminal:fresh-canary"],
  }));
  const diff = diffGatewayConfigs(backup, cfg);

  assert.ok(diff.some((line) => line.includes("operatorEvents.terminalOutboxCursor")), "diff must include terminalOutboxCursor change");
  assert.ok(diff.some((line) => line.includes("operatorEvents.terminalOutboxAllowedIds")), "diff must include terminalOutboxAllowedIds change");
  assert.ok(diff.some((line) => line.includes("operatorEvents.terminalOutboxReconcileUnackedOnStart")), "diff must include terminalOutboxReconcileUnackedOnStart change");
});

test("diffGatewayConfigs returns empty array when no changes", () => {
  const cfg = baseConfig({
    operatorEvents: { enabled: true, notification: { enabled: true, channel: "telegram", to: "op" } },
  });
  const backup = createGatewayConfigBackup(cfg);
  const diff = diffGatewayConfigs(backup, cfg);
  assert.equal(diff.length, 0, "diff must be empty for unchanged config");
});

// ── Validate ────────────────────────────────────────────────────────

test("validateConfigBridgeApplication passes for well-formed config", () => {
  const cfg = baseConfig();
  applyGatewayConfigBridge(cfg, buildOperatorNotificationConfigTemplate("telegram", "operator-chat"));

  const checks = validateConfigBridgeApplication(cfg, buildOperatorNotificationConfigTemplate("telegram", "operator-chat"));
  assert.ok(checks.every((c) => c.ok), `all checks must pass, but failures: ${checks.filter((c) => !c.ok).map((c) => `${c.code}: ${c.detail}`).join("; ")}`);
});

test("validateConfigBridgeApplication fails when plugin entry is missing", () => {
  const checks = validateConfigBridgeApplication(
    configWithoutPluginEntry(),
    buildOperatorNotificationConfigTemplate("telegram", "operator-chat"),
  );
  const pluginEntry = checks.find((c) => c.code === "plugin_entry_missing");
  assert.ok(pluginEntry, "must detect missing plugin entry");
  assert.equal(pluginEntry.ok, false);
});

test("validateConfigBridgeApplication fails when plugin is disabled", () => {
  const checks = validateConfigBridgeApplication(
    configWithPluginDisabled(),
    buildOperatorNotificationConfigTemplate("telegram", "operator-chat"),
  );
  const pluginEnabled = checks.find((c) => c.code === "plugin_enabled");
  assert.equal(pluginEnabled && pluginEnabled.ok, false);
});

test("validateConfigBridgeApplication fails when notification.channel mismatches", () => {
  const cfg = baseConfig();
  applyGatewayConfigBridge(cfg, buildOperatorNotificationConfigTemplate("telegram", "operator-chat"));

  const checks = validateConfigBridgeApplication(cfg, {
    operatorEventsEnabled: true,
    notificationEnabled: true,
    notificationChannel: "discord", // mismatched
    notificationTo: "operator-chat",
  });
  const channelCheck = checks.find((c) => c.code === "notification_channel");
  assert.equal(channelCheck && channelCheck.ok, false);
});

test("validateConfigBridgeApplication fails when operatorEvents.enabled mismatches", () => {
  const cfg = baseConfig();
  applyGatewayConfigBridge(cfg, buildOperatorEventsOnlyTemplate());

  const checks = validateConfigBridgeApplication(cfg, {
    operatorEventsEnabled: false, // mismatched — was set to true
  });
  const oeCheck = checks.find((c) => c.code === "operator_events_enabled_match");
  assert.equal(oeCheck && oeCheck.ok, false);
});

test("validateConfigBridgeApplication skips notification validation when not requested", () => {
  const cfg = baseConfig();
  applyGatewayConfigBridge(cfg, { operatorEventsEnabled: true });

  const checks = validateConfigBridgeApplication(cfg, { operatorEventsEnabled: true });
  assert.ok(checks.every((c) => c.ok));
});

test("validateConfigBridgeApplication rejects runtime-only operatorEvents fields before restart", () => {
  const cfg = baseConfig({
    operatorEvents: {
      enabled: true,
      terminalOutboxLimit: 20,
      terminalOutboxHistoricalReplay: "suppress",
    },
  });

  const checks = validateConfigBridgeApplication(cfg, { operatorEventsEnabled: true });
  const schemaCheck = checks.find((c) => c.code === "operator_events_schema_keys");
  assert.equal(schemaCheck && schemaCheck.ok, false);
  assert.match(schemaCheck?.detail ?? "", /terminalOutboxLimit/);
  assert.match(schemaCheck?.detail ?? "", /terminalOutboxHistoricalReplay/);
});

test("validateOperatorEventsLiveConfigShape accepts schema-valid Terminal Brief canary keys", () => {
  const checks = validateOperatorEventsLiveConfigShape({
    enabled: true,
    notification: {
      enabled: true,
      channel: "telegram",
      to: "telegram:operator-chat",
      accountId: "default",
      allowUnconfirmedProviderSend: false,
    },
    terminalOutboxCursor: "terminal:previous:succeeded:2026-05-17T00%3A00%3A00.000Z",
    terminalOutboxAllowedIds: ["terminal:fresh-canary"],
    terminalOutboxReconcileUnackedOnStart: false,
  });
  assert.ok(checks.every((c) => c.ok), `all checks must pass, failures: ${JSON.stringify(checks.filter((c) => !c.ok))}`);
});

test("validateOperatorEventsLiveConfigShape rejects unsupported notification keys", () => {
  const checks = validateOperatorEventsLiveConfigShape({
    enabled: true,
    notification: {
      enabled: true,
      channel: "telegram",
      to: "telegram:operator-chat",
      botToken: "must-not-be-accepted",
    },
  });
  const notificationSchemaCheck = checks.find((c) => c.code === "operator_events_notification_schema_keys");
  assert.equal(notificationSchemaCheck && notificationSchemaCheck.ok, false);
  assert.match(notificationSchemaCheck?.detail ?? "", /botToken/);
});

// ── Safe apply ──────────────────────────────────────────────────────

test("applyGatewayConfigBridgeSafe succeeds for valid settings", () => {
  const cfg = baseConfig();
  const result = applyGatewayConfigBridgeSafe(cfg, buildOperatorNotificationConfigTemplate("telegram", "operator-chat"));

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected ok");

  assert.ok(result.diff.length > 0, "diff must show changes");
  assert.equal(result.resolved.operatorEventsEnabled, true);

  // Config must be mutated in place
  /** @type {Record<string, unknown>} */
  const pluginCfg = cfg.plugins.entries["a2a-broker-adapter"].config;
  const oe = /** @type {Record<string, unknown>} */ (pluginCfg.operatorEvents);
  assert.equal(oe.enabled, true);
  const notif = /** @type {Record<string, unknown>} */ (oe.notification);
  assert.equal(notif.enabled, true);
  assert.equal(notif.channel, "telegram");
  assert.equal(notif.to, "operator-chat");
});

test("applyGatewayConfigBridgeSafe rolls back on disabled-plugin config", () => {
  const cfg = configWithPluginDisabled();

  const result = applyGatewayConfigBridgeSafe(cfg, buildOperatorNotificationConfigTemplate("telegram", "operator-chat"));

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");

  // Config must be restored to its original state
  const restored = cfg.plugins.entries["a2a-broker-adapter"];
  assert.equal(restored.enabled, false, "plugin.enabled must be restored to false after rollback");
  assert.deepEqual(restored.config, {}, "plugin config must be restored to empty object");
});

test("applyGatewayConfigBridgeSafe rollback preserves non-plugin config", () => {
  const cfg = configWithPluginDisabled();
  const result = applyGatewayConfigBridgeSafe(cfg, buildOperatorNotificationConfigTemplate("telegram", "operator-chat"));

  assert.equal(result.ok, false);
  // verify rollback kept the plugin disabled
  assert.equal(cfg.plugins.entries["a2a-broker-adapter"].enabled, false);
});

test("applyGatewayConfigBridgeSafe succeeds for operatorEvents-only template", () => {
  const cfg = baseConfig();
  const result = applyGatewayConfigBridgeSafe(cfg, buildOperatorEventsOnlyTemplate());

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected ok");

  /** @type {Record<string, unknown>} */
  const pluginCfg = cfg.plugins.entries["a2a-broker-adapter"].config;
  const oe = /** @type {Record<string, unknown>} */ (pluginCfg.operatorEvents);
  assert.equal(oe.enabled, true);
  const notif = /** @type {Record<string, unknown>} */ (oe.notification);
  assert.equal(notif.enabled, false);
});

test("applyGatewayConfigBridgeSafe succeeds with all optional fields", () => {
  const cfg = baseConfig();
  const result = applyGatewayConfigBridgeSafe(cfg, {
    operatorEventsEnabled: true,
    notificationEnabled: true,
    notificationChannel: "telegram",
    notificationTo: "operator-chat",
    notificationAccountId: "account-1",
    notificationThreadId: 789,
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected ok");

  /** @type {Record<string, unknown>} */
  const pluginCfg = cfg.plugins.entries["a2a-broker-adapter"].config;
  const oe = /** @type {Record<string, unknown>} */ (pluginCfg.operatorEvents);
  const notif = /** @type {Record<string, unknown>} */ (oe.notification);
  assert.equal(notif.accountId, "account-1");
  assert.equal(notif.threadId, 789);
});

test("applyGatewayConfigBridgeSafe rolls back when existing config contains runtime-only live fields", () => {
  const cfg = baseConfig({
    operatorEvents: {
      enabled: false,
      terminalOutboxLimit: 20,
      terminalOutboxHistoricalReplay: "suppress",
    },
  });
  const originalClone = JSON.parse(JSON.stringify(cfg));

  const result = applyGatewayConfigBridgeSafe(cfg, buildTerminalOutboxLiveCanaryConfigTemplate({
    channel: "telegram",
    to: "telegram:operator-chat",
    cursor: "terminal:previous:succeeded:2026-05-17T00%3A00%3A00.000Z",
    allowedIds: ["terminal:fresh-canary"],
  }));

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  assert.match(result.reason, /unsupported live config key/);
  assert.deepEqual(cfg, originalClone, "invalid config must be restored unchanged after failed safe apply");
});

// ── Template builders ───────────────────────────────────────────────

test("buildOperatorNotificationConfigTemplate returns correct settings", () => {
  const template = buildOperatorNotificationConfigTemplate("discord", "operator-channel");
  assert.equal(template.operatorEventsEnabled, true);
  assert.equal(template.notificationEnabled, true);
  assert.equal(template.notificationChannel, "discord");
  assert.equal(template.notificationTo, "operator-channel");
  assert.equal(template.notificationAccountId, undefined);
  assert.equal(template.notificationThreadId, undefined);
});

test("buildOperatorEventsOnlyTemplate enables events but not notification", () => {
  const template = buildOperatorEventsOnlyTemplate();
  assert.equal(template.operatorEventsEnabled, true);
  assert.equal(template.notificationEnabled, false);
  assert.equal(template.notificationChannel, undefined);
  assert.equal(template.notificationTo, undefined);
});

test("buildTerminalOutboxLiveCanaryConfigTemplate returns schema-valid bounded live settings", () => {
  const template = buildTerminalOutboxLiveCanaryConfigTemplate({
    channel: "telegram",
    to: "telegram:operator-chat",
    cursor: "terminal:previous:succeeded:2026-05-17T00%3A00%3A00.000Z",
    allowedIds: ["terminal:fresh-canary"],
  });

  assert.equal(template.operatorEventsEnabled, true);
  assert.equal(template.notificationEnabled, true);
  assert.equal(template.notificationChannel, "telegram");
  assert.equal(template.notificationTo, "telegram:operator-chat");
  assert.equal(template.terminalOutboxCursor, "terminal:previous:succeeded:2026-05-17T00%3A00%3A00.000Z");
  assert.deepEqual(template.terminalOutboxAllowedIds, ["terminal:fresh-canary"]);
  assert.equal(template.terminalOutboxReconcileUnackedOnStart, false);
  assert.equal(Object.hasOwn(template, "terminalOutboxLimit"), false);
  assert.equal(Object.hasOwn(template, "terminalOutboxHistoricalReplay"), false);
});

// ── Internal consistency check ──────────────────────────────────────

test("isOperatorEventsConfigInternallyConsistent returns true for well-formed config", () => {
  const cfg = baseConfig({
    operatorEvents: {
      enabled: true,
      notification: { enabled: true, channel: "telegram", to: "operator-chat" },
    },
  });
  assert.equal(isOperatorEventsConfigInternallyConsistent(cfg), true);
});

test("isOperatorEventsConfigInternallyConsistent returns false for nil config", () => {
  assert.equal(isOperatorEventsConfigInternallyConsistent(null), false);
  assert.equal(isOperatorEventsConfigInternallyConsistent(undefined), false);
});

test("isOperatorEventsConfigInternallyConsistent returns false when operator events disabled", () => {
  const cfg = baseConfig();
  assert.equal(isOperatorEventsConfigInternallyConsistent(cfg), false);
});

test("isOperatorEventsConfigInternallyConsistent returns false when notification enabled but missing channel", () => {
  const cfg = baseConfig({
    operatorEvents: {
      enabled: true,
      notification: { enabled: true, to: "operator-chat" },
    },
  });
  assert.equal(isOperatorEventsConfigInternallyConsistent(cfg), false);
});

test("isOperatorEventsConfigInternallyConsistent returns false when notification enabled but missing to", () => {
  const cfg = baseConfig({
    operatorEvents: {
      enabled: true,
      notification: { enabled: true, channel: "telegram" },
    },
  });
  assert.equal(isOperatorEventsConfigInternallyConsistent(cfg), false);
});

test("isOperatorEventsConfigInternallyConsistent returns true when notification disabled", () => {
  const cfg = baseConfig({
    operatorEvents: {
      enabled: true,
      notification: { enabled: false, channel: "telegram", to: "operator-chat" },
    },
  });
  assert.equal(isOperatorEventsConfigInternallyConsistent(cfg), true);
});

test("isOperatorEventsConfigInternallyConsistent returns false for unsupported runtime-only live fields", () => {
  const cfg = baseConfig({
    operatorEvents: {
      enabled: true,
      notification: { enabled: true, channel: "telegram", to: "operator-chat" },
      terminalOutboxLimit: 20,
    },
  });
  assert.equal(isOperatorEventsConfigInternallyConsistent(cfg), false);
});

// ── End-to-end: full backup → apply → verify → rollback cycle ──────

test("full cycle: apply succeeds, config diff shows all changes, backup works for restore", () => {
  const cfg = baseConfig();
  const originalClone = JSON.parse(JSON.stringify(cfg));

  const result = applyGatewayConfigBridgeSafe(cfg, buildOperatorNotificationConfigTemplate("telegram", "to-target"));

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected ok");

  // Diff must show the specific changes
  assert.ok(result.diff.length > 0);
  assert.ok(result.diff.some((d) => d.includes("operatorEvents.enabled")));
  assert.ok(result.diff.some((d) => d.includes("notification.enabled")));

  // Backup must be usable for restore
  assert.ok(result.backup.entry, "backup entry must exist");

  // Restore from backup must return to original
  restoreGatewayConfigFromBackup(cfg, result.backup);
  assert.deepEqual(cfg, originalClone, "restore from backup must return to original config");
});

test("full cycle: failed apply rolls back and leaves config unchanged", () => {
  const cfg = configWithPluginDisabled();
  const originalClone = JSON.parse(JSON.stringify(cfg));

  const result = applyGatewayConfigBridgeSafe(cfg, buildOperatorNotificationConfigTemplate("telegram", "to-target"));

  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
  assert.ok(result.failures.length > 0);

  // Config must be identical to original after rollback
  assert.deepEqual(cfg, originalClone, "config must be unchanged after failed apply + rollback");
});
