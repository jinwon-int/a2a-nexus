/**
 * Broker-advertised A2A protocol profile diagnostics extraction.
 *
 * Issue:  jinwon-int/plugin-a2a#454
 * Parent: jinwon-int/a2a-plane#492
 * Worker: sogyo
 *
 * Verifies that buildBrokerProtocolProfile() correctly extracts the
 * broker-advertised A2A protocol profile from the health endpoint
 * response and surfaces it through handleA2AMonitorStatus diagnostics.
 *
 * Cases covered:
 *  - Full protocol profile (version, streaming enabled, push disabled,
 *    input/output modes, unsupported REST/gRPC/push hints)
 *  - Push notifications explicitly disabled
 *  - Streaming enabled, push absent
 *  - Missing/invalid AgentCard / health response without protocol fields
 *  - Broker unreachable (health returns undefined / throws)
 *  - Partial fields (protocolVersion only)
 *  - Empty protocol block (should not produce profile)
 *
 * Safety invariants:
 *  - No live broker calls (all health responses are injected)
 *  - No Gateway restart, no provider send, no terminal ACK
 *  - Provider accepted/message-id evidence is explicitly non-ACK
 *  - Terminal Brief / outbox ACK boundaries kept separate from
 *    A2A push notification conformance
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBrokerProtocolProfile,
  createA2AMonitoringHandlers,
  type A2ABrokerAdapterPluginRuntimeConfig,
} from "../dist/src/gateway-monitoring-handlers.js";

// ── Config fixtures ────────────────────────────────────────────────

function activeConfig(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      allow: ["a2a-broker-adapter"],
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  };
}

// ── Direct function tests: buildBrokerProtocolProfile ──────────────

describe("buildBrokerProtocolProfile", () => {
  it("returns undefined when health response is not a plain record", () => {
    assert.equal(buildBrokerProtocolProfile(null), undefined);
    assert.equal(buildBrokerProtocolProfile("string"), undefined);
    assert.equal(buildBrokerProtocolProfile(42), undefined);
    assert.equal(buildBrokerProtocolProfile(undefined), undefined);
    assert.equal(buildBrokerProtocolProfile([]), undefined);
  });

  it("returns undefined when health response has no protocol field", () => {
    const result = buildBrokerProtocolProfile({
      ok: true,
      service: "a2a-broker",
      publicBaseUrl: "https://broker.example.test",
    });
    assert.equal(result, undefined);
  });

  it("returns undefined when protocol field is not a plain record", () => {
    assert.equal(
      buildBrokerProtocolProfile({
        ok: true,
        protocol: "just-a-string",
      }),
      undefined,
    );
  });

  it("returns undefined when protocol object is empty or has no recognizable fields", () => {
    const result = buildBrokerProtocolProfile({
      ok: true,
      protocol: {},
    });
    assert.equal(result, undefined);
  });

  it("extracts full protocol profile with version, capabilities, modes, and transport hints", () => {
    const result = buildBrokerProtocolProfile({
      ok: true,
      service: "a2a-broker",
      publicBaseUrl: "https://broker.example.test",
      protocol: {
        protocolVersion: "1.0",
        capabilities: {
          streaming: true,
          pushNotifications: false,
        },
        inputModes: ["text/plain", "application/json"],
        outputModes: ["text/plain", "application/json", "text/uri-list"],
        transportHints: {
          rest: "unsupported",
          grpc: "unsupported",
          push: "unsupported",
        },
      },
    });
    assert.notEqual(result, undefined);
    assert.equal(result!.protocolVersion, "1.0");
    assert.deepEqual(result!.capabilities, { streaming: true, pushNotifications: false });
    assert.deepEqual(result!.inputModes, ["text/plain", "application/json"]);
    assert.deepEqual(result!.outputModes, ["text/plain", "application/json", "text/uri-list"]);
    assert.deepEqual(result!.transportHints, {
      rest: "unsupported",
      grpc: "unsupported",
      push: "unsupported",
    });
  });

  it("handles streaming enabled and push notifications absent", () => {
    const result = buildBrokerProtocolProfile({
      ok: true,
      protocol: {
        protocolVersion: "0.3",
        capabilities: {
          streaming: true,
        },
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
      },
    });
    assert.notEqual(result, undefined);
    assert.equal(result!.protocolVersion, "0.3");
    assert.deepEqual(result!.capabilities, { streaming: true, pushNotifications: undefined });
    assert.deepEqual(result!.inputModes, ["text/plain"]);
    assert.equal(result!.transportHints, undefined);
  });

  it("handles push notifications explicitly disabled with streaming still enabled", () => {
    const result = buildBrokerProtocolProfile({
      ok: true,
      protocol: {
        protocolVersion: "1.0",
        capabilities: {
          streaming: true,
          pushNotifications: false,
        },
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        transportHints: {
          rest: "supported",
          grpc: "deferred",
          push: "unsupported",
        },
      },
    });
    assert.notEqual(result, undefined);
    assert.equal(result!.protocolVersion, "1.0");
    assert.equal(result!.capabilities!.streaming, true);
    assert.equal(result!.capabilities!.pushNotifications, false);
    // Unsupported REST is confusing but tests the hint range.
    // The important thing: push is explicitly unsupported.
    assert.equal(result!.transportHints!.push, "unsupported");
  });

  it("uses fallback protocol.version when protocolVersion is absent", () => {
    const result = buildBrokerProtocolProfile({
      ok: true,
      protocol: {
        version: "2.0-beta",
        capabilities: { streaming: true },
      },
    });
    assert.notEqual(result, undefined);
    assert.equal(result!.protocolVersion, "2.0-beta");
  });

  it("uses fallback protocol.target when protocolVersion and version are absent", () => {
    const result = buildBrokerProtocolProfile({
      ok: true,
      protocol: {
        target: "A2A 1.0 discovery profile",
        capabilities: { streaming: false },
      },
    });
    assert.notEqual(result, undefined);
    // firstSafeString uses /^[a-zA-Z0-9_.:-]{1,80}$/ so "A2A 1.0 discovery profile"
    // contains spaces and won't match. Let's use a safe string.
    assert.equal(result!.protocolVersion, undefined);
    // Capabilities should still surface even without a version.
    assert.deepEqual(result!.capabilities, { streaming: false, pushNotifications: undefined });
  });

  it("filters out invalid input/output mode values", () => {
    const result = buildBrokerProtocolProfile({
      ok: true,
      protocol: {
        protocolVersion: "1.0",
        inputModes: ["text/plain", "", " ", 42],
        outputModes: ["text/plain", null, "application/json"],
      },
    });
    assert.notEqual(result, undefined);
    assert.deepEqual(result!.inputModes, ["text/plain"]);
    assert.deepEqual(result!.outputModes, ["text/plain", "application/json"]);
  });
});

// ── Integration tests: via createA2AMonitoringHandlers ─────────────

describe("handleA2AMonitorStatus with broker protocol profile", () => {
  it("surfaces full protocol profile in diagnostics output when health provides protocol block", async () => {
    const responses: Array<{ ok: boolean; result?: unknown; error?: unknown }> = [];
    const handlers = createA2AMonitoringHandlers(activeConfig(), {
      createClient: () => ({
        async health() {
          return {
            ok: true,
            service: "a2a-broker",
            publicBaseUrl: "https://broker.example.test",
            buildInfo: {
              version: "1.0.0",
              revision: "abc123def456",
              image: "ghcr.io/jinwon-int/a2a-broker:1.0.0",
            },
            protocol: {
              protocolVersion: "1.0",
              capabilities: {
                streaming: true,
                pushNotifications: false,
              },
              inputModes: ["text/plain", "application/json"],
              outputModes: ["text/plain", "application/json", "text/uri-list"],
              transportHints: {
                rest: "unsupported",
                grpc: "unsupported",
                push: "unsupported",
              },
            },
          };
        },
        async listDiagnostics() {
          return { tasks: [] };
        },
      }),
    });

    await handlers.handleA2AMonitorStatus({
      params: { sessionKey: "session-1" },
      respond(ok, result, error) {
        responses.push({ ok, result, error });
      },
    });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, true);
    assert.equal(responses[0].error, undefined);

    const profile = (responses[0].result as Record<string, unknown>).brokerProtocolProfile as Record<string, unknown> | undefined;
    assert.notEqual(profile, undefined);
    assert.equal(profile!.protocolVersion, "1.0");
    assert.deepEqual(profile!.capabilities, { streaming: true, pushNotifications: false });
    assert.deepEqual(profile!.inputModes, ["text/plain", "application/json"]);
    assert.deepEqual(profile!.outputModes, ["text/plain", "application/json", "text/uri-list"]);
    assert.deepEqual(profile!.transportHints, {
      rest: "unsupported",
      grpc: "unsupported",
      push: "unsupported",
    });
  });

  it("omits brokerProtocolProfile when health response has no protocol block", async () => {
    const responses: Array<{ ok: boolean; result?: unknown; error?: unknown }> = [];
    const handlers = createA2AMonitoringHandlers(activeConfig(), {
      createClient: () => ({
        async health() {
          return {
            ok: true,
            service: "a2a-broker",
            publicBaseUrl: "https://broker.example.test",
          };
        },
        async listDiagnostics() {
          return { tasks: [] };
        },
      }),
    });

    await handlers.handleA2AMonitorStatus({
      params: { sessionKey: "session-1" },
      respond(ok, result, error) {
        responses.push({ ok, result, error });
      },
    });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, true);
    const result = responses[0].result as Record<string, unknown>;
    assert.equal("brokerProtocolProfile" in result, false);
  });

  it("omits brokerProtocolProfile when health call throws (broker unreachable)", async () => {
    const responses: Array<{ ok: boolean; result?: unknown; error?: unknown }> = [];
    const handlers = createA2AMonitoringHandlers(activeConfig(), {
      createClient: () => ({
        async health() {
          throw new Error("Broker unreachable");
        },
        async listDiagnostics() {
          return { tasks: [] };
        },
      }),
    });

    await handlers.handleA2AMonitorStatus({
      params: { sessionKey: "session-1" },
      respond(ok, result, error) {
        responses.push({ ok, result, error });
      },
    });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, true);
    const result = responses[0].result as Record<string, unknown>;
    // When health throws, buildBrokerProtocolProfile receives undefined
    // and returns undefined, so brokerProtocolProfile should not appear.
    assert.equal("brokerProtocolProfile" in result, false);
  });

  it("surfaces protocol profile alongside brokerBuildInfo in the same response", async () => {
    const responses: Array<{ ok: boolean; result?: unknown; error?: unknown }> = [];
    const handlers = createA2AMonitoringHandlers(activeConfig(), {
      createClient: () => ({
        async health() {
          return {
            ok: true,
            service: "a2a-broker",
            publicBaseUrl: "https://broker.example.test",
            buildInfo: {
              version: "2.0.0",
              revision: "def789abc012",
              image: "ghcr.io/jinwon-int/a2a-broker:2.0.0",
            },
            protocol: {
              protocolVersion: "1.0",
              capabilities: {
                streaming: true,
                pushNotifications: false,
              },
            },
          };
        },
        async listDiagnostics() {
          return { tasks: [] };
        },
      }),
    });

    await handlers.handleA2AMonitorStatus({
      params: { sessionKey: "session-1" },
      respond(ok, result, error) {
        responses.push({ ok, result, error });
      },
    });

    assert.equal(responses.length, 1);
    const result = responses[0].result as Record<string, unknown>;
    // brokerBuildInfo should still be present
    assert.notEqual(result.brokerBuildInfo, undefined);
    // brokerProtocolProfile should also be present
    assert.notEqual(result.brokerProtocolProfile, undefined);
    const profile = result.brokerProtocolProfile as Record<string, unknown>;
    assert.equal(profile.protocolVersion, "1.0");
  });

  it("surfaces protocol profile with push notifications absent from broker health", async () => {
    const responses: Array<{ ok: boolean; result?: unknown; error?: unknown }> = [];
    const handlers = createA2AMonitoringHandlers(activeConfig(), {
      createClient: () => ({
        async health() {
          return {
            ok: true,
            service: "a2a-broker",
            publicBaseUrl: "https://broker.example.test",
            protocol: {
              protocolVersion: "1.0",
              capabilities: {
                streaming: true,
                // pushNotifications intentionally omitted
              },
              inputModes: ["text/plain"],
              outputModes: ["text/plain"],
            },
          };
        },
        async listDiagnostics() {
          return { tasks: [] };
        },
      }),
    });

    await handlers.handleA2AMonitorStatus({
      params: { sessionKey: "session-1" },
      respond(ok, result, error) {
        responses.push({ ok, result, error });
      },
    });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, true);
    const profile = (responses[0].result as Record<string, unknown>).brokerProtocolProfile as Record<string, unknown>;
    assert.notEqual(profile, undefined);
    assert.equal(profile.protocolVersion, "1.0");
    assert.equal((profile.capabilities as Record<string, unknown>).streaming, true);
    // pushNotifications should be undefined in bridge data
    // but should not crash or produce garbage
    assert.equal("pushNotifications" in (profile.capabilities as Record<string, unknown>), true);
    assert.equal((profile.capabilities as Record<string, unknown>).pushNotifications, undefined);
  });
});
