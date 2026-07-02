import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";

async function loadValidator() {
  const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(manifest.configSchema);
}

test("plugin config schema accepts operatorEvents.notification target for receipt-confirmed Telegram delivery", async () => {
  const validate = await loadValidator();
  const config = {
    baseUrl: "https://broker.example.test",
    operatorEvents: {
      enabled: true,
      notification: {
        enabled: true,
        channel: "telegram",
        to: "telegram:<operator-chat-id>",
        accountId: "default",
        threadId: "round-2",
      },
    },
  };

  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test("plugin config schema accepts chatId alias for operatorEvents.notification target", async () => {
  const validate = await loadValidator();
  const config = {
    operatorEvents: {
      enabled: true,
      notification: {
        enabled: true,
        channel: "telegram",
        chatId: "telegram:<operator-chat-id>",
      },
    },
  };

  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test("plugin config schema accepts bounded terminal-outbox canary config keys", async () => {
  const validate = await loadValidator();
  const config = {
    operatorEvents: {
      enabled: true,
      notification: {
        enabled: true,
        channel: "telegram",
        to: "telegram:<operator-chat-id>",
      },
      terminalOutboxCursor: "terminal:previous:succeeded:2026-05-17T00%3A00%3A00.000Z",
      terminalOutboxAllowedIds: ["terminal:known-event", "client-request-id"],
      terminalOutboxReconcileUnackedOnStart: false,
    },
  };

  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test("plugin config schema accepts bounded cross-broker Terminal Brief pull config", async () => {
  const validate = await loadValidator();
  const config = {
    operatorEvents: {
      enabled: true,
      localBrokerId: "brokerAlpha",
      crossBrokers: [
        {
          baseUrl: "https://team2-broker.example.test",
          edgeSecretFile: "/root/.openclaw/secrets/team2-broker-edge-secret",
          label: "brokerBeta",
          requesterId: "brokerAlpha-cross-broker-terminal-brief",
          terminalOutboxAllowedIds: ["terminal:round-1-team2"],
          terminalOutboxCursor: "terminal:previous-team2",
          terminalOutboxReconcileUnackedOnStart: false,
          localBrokerId: "brokerAlpha",
          maxSummaryChars: 480,
        },
      ],
      crossBrokerTerminalRelay: {
        enabled: true,
        originBroker: {
          baseUrl: "https://origin-broker.example.test",
          edgeSecretFile: "/root/.openclaw/secrets/origin-broker-edge-secret",
          label: "brokerAlpha",
        },
        handoffBrokerId: "brokerBeta",
      },
    },
  };

  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test("plugin config schema rejects runtime-only terminal-outbox tuning fields", async () => {
  const validate = await loadValidator();
  const config = {
    operatorEvents: {
      enabled: true,
      terminalOutboxLimit: 25,
      terminalOutboxHistoricalReplay: "suppress",
    },
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "/operatorEvents" && error.keyword === "additionalProperties"));
});

test("plugin config schema rejects unknown operatorEvents.notification properties", async () => {
  const validate = await loadValidator();
  const config = {
    operatorEvents: {
      enabled: true,
      notification: {
        enabled: true,
        channel: "telegram",
        to: "telegram:<operator-chat-id>",
        botToken: "must-not-be-accepted-here",
      },
    },
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "/operatorEvents/notification" && error.keyword === "additionalProperties"));
});

test("plugin config schema rejects edgeSecret as arbitrary object", async () => {
  const validate = await loadValidator();
  const config = {
    baseUrl: "https://broker.example.test",
    edgeSecret: { key: "secret-value", provider: "vault" },
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "/edgeSecret" && error.keyword === "type"));
});

test("plugin config schema accepts edgeSecret as string", async () => {
  const validate = await loadValidator();
  const config = {
    baseUrl: "https://broker.example.test",
    edgeSecret: "x-a2a-shared-secret",
  };

  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test("plugin config schema rejects edgeSecret as empty string", async () => {
  const validate = await loadValidator();
  const config = {
    baseUrl: "https://broker.example.test",
    edgeSecret: "",
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "/edgeSecret" && error.keyword === "minLength"));
});

test("plugin config schema rejects unknown top-level property", async () => {
  const validate = await loadValidator();
  const config = {
    baseUrl: "https://broker.example.test",
    unknownField: "should-not-be-allowed",
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.keyword === "additionalProperties"));
});

test("plugin config schema rejects unknown requester property", async () => {
  const validate = await loadValidator();
  const config = {
    requester: {
      id: "req-1",
      kind: "session",
      injected: "malicious",
    },
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "/requester" && error.keyword === "additionalProperties"));
});

test("plugin config schema rejects unknown operatorEvents property", async () => {
  const validate = await loadValidator();
  const config = {
    operatorEvents: {
      enabled: true,
      injected: "malicious",
    },
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "/operatorEvents" && error.keyword === "additionalProperties"));
});

test("plugin config schema rejects unknown wakeOnTask property", async () => {
  const validate = await loadValidator();
  const config = {
    wakeOnTask: {
      enabled: true,
      injected: "malicious",
    },
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "/wakeOnTask" && error.keyword === "additionalProperties"));
});

test("plugin config schema accepts valid requester with kind and role enums", async () => {
  const validate = await loadValidator();
  const config = {
    baseUrl: "https://broker.example.test",
    requester: {
      id: "req-1",
      kind: "session",
      role: "operator",
    },
  };

  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test("plugin config schema rejects invalid requester.kind enum", async () => {
  const validate = await loadValidator();
  const config = {
    requester: {
      id: "req-1",
      kind: "attacker",
    },
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "/requester/kind" && error.keyword === "enum"));
});

test("plugin config schema rejects invalid requester.role enum", async () => {
  const validate = await loadValidator();
  const config = {
    requester: {
      id: "req-1",
      role: "admin",
    },
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "/requester/role" && error.keyword === "enum"));
});

test("plugin config schema rejects baseUrl without https:// scheme", async () => {
  const validate = await loadValidator();
  const config = {
    baseUrl: "ftp://broker.example.test",
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "/baseUrl" && error.keyword === "pattern"));
});

test("plugin config schema rejects empty requester.id", async () => {
  const validate = await loadValidator();
  const config = {
    requester: {
      id: "",
      kind: "session",
    },
  };

  assert.equal(validate(config), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "/requester/id" && error.keyword === "minLength"));
});
