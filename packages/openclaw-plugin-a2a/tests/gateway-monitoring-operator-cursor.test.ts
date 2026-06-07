import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createA2AMonitoringHandlers } from "../dist/src/gateway-monitoring-handlers.js";

describe("gateway monitoring operator event cursor", () => {
  it("uses the configured operatorEvents.cursor when the Gateway starts the bridge", async () => {
    let lastEventId: string | undefined;

    const broker = {
      async *streamOperatorEvents(options: { lastEventId?: string; signal?: AbortSignal } = {}) {
        lastEventId = options.lastEventId;
        if (!options.signal?.aborted) {
          await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        }
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          events: [],
          cursor: "terminal:latest",
        };
      },
    };

    const handlers = createA2AMonitoringHandlers(
      {
        plugins: {
          entries: {
            "a2a-broker-adapter": {
              enabled: true,
              config: {
                baseUrl: "http://127.0.0.1:8787",
                edgeSecret: "test-secret",
                requester: { id: "gwakga", kind: "node", role: "operator" },
                operatorEvents: {
                  enabled: true,
                  cursor: "operator:14",
                  terminalOutboxCursor: "terminal:latest",
                  terminalOutboxReconcileUnackedOnStart: false,
                },
              },
            },
          },
        },
      },
      {
        createClient: () => broker as never,
        now: () => Date.parse("2026-05-20T00:00:00.000Z"),
      },
    );

    try {
      handlers.startOperatorEventBridge();
      for (let attempt = 0; attempt < 20 && lastEventId === undefined; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(lastEventId, "operator:14");
    } finally {
      handlers.shutdownOperatorEventBridge();
    }
  });

  it("passes operatorEvents.localBrokerId to the primary Terminal Brief bridge", () => {
    let bridgeParams: { handoffBrokerId?: string } | undefined;
    const broker = {
      async *streamOperatorEvents() {
        // no-op
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          events: [],
          cursor: "terminal:latest",
        };
      },
    };

    const handlers = createA2AMonitoringHandlers(
      {
        plugins: {
          entries: {
            "a2a-broker-adapter": {
              enabled: true,
              config: {
                baseUrl: "http://127.0.0.1:8787",
                edgeSecret: "test-secret",
                requester: { id: "seoseo", kind: "node", role: "operator" },
                operatorEvents: {
                  enabled: true,
                  localBrokerId: "seoseo",
                  terminalOutboxCursor: "terminal:latest",
                  terminalOutboxReconcileUnackedOnStart: false,
                },
              },
            },
          },
        },
      },
      {
        createClient: () => broker as never,
        createOperatorEventBridge: (params) => {
          bridgeParams = params;
          return {
            getState: () => ({ ok: true }),
            shutdown: () => undefined,
            waitForIdle: async () => undefined,
          } as never;
        },
        now: () => Date.parse("2026-05-21T10:45:00.000Z"),
      },
    );

    try {
      handlers.startOperatorEventBridge();
      assert.equal(bridgeParams?.handoffBrokerId, "seoseo");
    } finally {
      handlers.shutdownOperatorEventBridge();
    }
  });

  it("wires crossBrokers as remote projection-only Terminal Brief bridges", async () => {
    const bridgeParams: Array<{
      broker?: unknown;
      handoffBrokerId?: string;
      notifyOperator?: boolean;
      relayTerminalProjection?: (projection: Record<string, unknown>) => Promise<unknown> | unknown;
    }> = [];
    const relayedProjections: Record<string, unknown>[] = [];
    const localBroker = {
      async *streamOperatorEvents() {
        // no-op
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          events: [],
          cursor: "terminal:local-latest",
        };
      },
      async relayTerminalProjection(projection: Record<string, unknown>) {
        relayedProjections.push(projection);
        return { accepted: true };
      },
    };
    const remoteBroker = {
      async *streamOperatorEvents() {
        // no-op
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          events: [],
          cursor: "terminal:remote-latest",
        };
      },
    };

    const handlers = createA2AMonitoringHandlers(
      {
        plugins: {
          entries: {
            "a2a-broker-adapter": {
              enabled: true,
              config: {
                baseUrl: "http://127.0.0.1:8787",
                edgeSecret: "test-secret",
                requester: { id: "seoseo", kind: "node", role: "operator" },
                operatorEvents: {
                  enabled: true,
                  localBrokerId: "seoseo",
                  terminalOutboxCursor: "terminal:local-latest",
                  terminalOutboxReconcileUnackedOnStart: false,
                  crossBrokers: [
                    {
                      label: "gwakga",
                      baseUrl: "https://team2-broker.example.test",
                      localBrokerId: "seoseo",
                      terminalOutboxCursor: "terminal:remote-previous",
                      terminalOutboxReconcileUnackedOnStart: false,
                    },
                  ],
                },
              },
            },
          },
        },
      },
      {
        createClient: () => localBroker as never,
        createStandaloneBrokerClient: () => remoteBroker as never,
        createOperatorEventBridge: (params) => {
          bridgeParams.push(params);
          return {
            getState: () => ({ ok: true }),
            shutdown: () => undefined,
            waitForIdle: async () => undefined,
          } as never;
        },
        now: () => Date.parse("2026-05-22T06:20:00.000Z"),
      },
    );

    try {
      handlers.startOperatorEventBridge();
      assert.equal(bridgeParams.length, 2);
      const primary = bridgeParams[0];
      const cross = bridgeParams[1];
      assert.equal(primary?.handoffBrokerId, "seoseo");
      assert.equal(cross?.broker, remoteBroker);
      assert.equal(cross?.handoffBrokerId, "gwakga");
      assert.equal(cross?.notifyOperator, false);
      assert.equal(typeof cross?.relayTerminalProjection, "function");

      await cross?.relayTerminalProjection?.({
        kind: "a2a.crossBroker.terminalProjection",
        version: 1,
        relayId: "relay-test",
      });
      assert.deepEqual(relayedProjections, [
        {
          kind: "a2a.crossBroker.terminalProjection",
          version: 1,
          relayId: "relay-test",
        },
      ]);
    } finally {
      handlers.shutdownOperatorEventBridge();
    }
  });

  it("starts and reports crossBrokers when monitor status lazily starts operator events", async () => {
    const bridgeParams: Array<{
      broker?: unknown;
      handoffBrokerId?: string;
      notifyOperator?: boolean;
      terminalOutboxCursor?: string;
    }> = [];
    const localBroker = {
      async *streamOperatorEvents() {
        // no-op
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          events: [],
          cursor: "terminal:local-latest",
        };
      },
      async relayTerminalProjection() {
        return { accepted: true };
      },
    };
    const remoteBroker = {
      async *streamOperatorEvents() {
        // no-op
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          events: [],
          cursor: "terminal:remote-latest",
        };
      },
    };

    const handlers = createA2AMonitoringHandlers(
      {
        plugins: {
          entries: {
            "a2a-broker-adapter": {
              enabled: true,
              config: {
                baseUrl: "http://127.0.0.1:8787",
                edgeSecret: "test-secret",
                requester: { id: "seoseo", kind: "node", role: "operator" },
                operatorEvents: {
                  enabled: true,
                  localBrokerId: "seoseo",
                  terminalOutboxCursor: "terminal:local-latest",
                  terminalOutboxReconcileUnackedOnStart: false,
                  crossBrokers: [
                    {
                      label: "gwakga",
                      baseUrl: "https://team2-broker.example.test",
                      localBrokerId: "seoseo",
                      terminalOutboxCursor: "terminal:remote-previous",
                      terminalOutboxReconcileUnackedOnStart: false,
                    },
                  ],
                },
              },
            },
          },
        },
      },
      {
        createClient: () => localBroker as never,
        createStandaloneBrokerClient: () => remoteBroker as never,
        createOperatorEventBridge: (params) => {
          const index = bridgeParams.push(params) - 1;
          return {
            getState: () => ({
              kind: index === 0 ? "primary" : "cross",
              operator: {
                terminalOutbox: {
                  cursor: params.terminalOutboxCursor,
                },
              },
            }),
            shutdown: () => undefined,
            waitForIdle: async () => undefined,
          } as never;
        },
        now: () => Date.parse("2026-05-23T07:20:00.000Z"),
      },
    );

    try {
      let response: { success: boolean; data?: Record<string, unknown>; error?: unknown } | undefined;
      await handlers.handleA2AMonitorStatus({
        params: { sessionKey: "current", operatorEvents: { enabled: true } },
        respond: (success, data, error) => {
          response = { success, data: data as Record<string, unknown>, error };
        },
      } as never);

      assert.equal(response?.success, true);
      assert.equal(bridgeParams.length, 2);
      assert.equal(bridgeParams[1]?.handoffBrokerId, "gwakga");
      assert.equal(bridgeParams[1]?.notifyOperator, false);
      assert.deepEqual(Object.keys(response?.data?.crossBrokers as Record<string, unknown>), ["gwakga"]);
      assert.deepEqual(response?.data?.crossBrokers, {
        gwakga: {
          kind: "cross",
          operator: {
            terminalOutbox: {
              cursor: "terminal:remote-previous",
            },
          },
        },
      });
    } finally {
      handlers.shutdownOperatorEventBridge();
    }
  });
});
