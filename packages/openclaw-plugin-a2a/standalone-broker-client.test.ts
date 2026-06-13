/**
 * A2A transport client (standalone-broker-client) request/response contract.
 *
 * Issue: a2a-nexus#648 — plugin test-parity coverage baseline.
 *
 * This plugin is the canonical LEGACY client of the broker's spec/legacy
 * split: it speaks the broker's task REST surface without negotiating an
 * A2A protocol version. These tests pin two load-bearing facts that the
 * broker's compatibility lane depends on:
 *
 *   1. The client does NOT send an `A2A-Version` request header on any verb
 *      (header-less legacy behavior). If a future change started sending one,
 *      the broker's legacy detection would mis-route this client.
 *   2. The client parses the broker's legacy task-record envelope shapes
 *      (the `{ task: ... }`-equivalent flat record returned by REST verbs)
 *      and surfaces broker JSON-RPC-style `{ error: { code, message } }`
 *      envelopes through A2ABrokerClientError.
 *
 * Pure unit: a stub fetch captures the outgoing Request and returns canned
 * Responses. No network, no broker process.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createA2ABrokerClient,
  A2ABrokerClientError,
  A2ABrokerMalformedResponseError,
  normalizeA2ABrokerBaseUrl,
  type A2ABrokerTaskRecord,
} from "./dist/standalone-broker-client.js";

// ── Helpers ───────────────────────────────────────────────────

type CapturedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
};

function makeFetchStub(responder: (req: CapturedRequest) => Response) {
  const calls: CapturedRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body,
    };
    calls.push(captured);
    return responder(captured);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A legacy broker task-record envelope as returned by the REST task verbs.
function legacyTaskRecord(overrides: Partial<A2ABrokerTaskRecord> = {}): A2ABrokerTaskRecord {
  return {
    id: "task-1",
    intent: "chat",
    requester: { id: "hub-session", kind: "session", role: "hub" },
    target: { id: "worker-a", kind: "node" },
    status: "queued",
    targetNodeId: "worker-a",
    payload: { targetSessionKey: "worker-a", targetDisplayKey: "worker-a" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as A2ABrokerTaskRecord;
}

const BASE = "https://broker.example";

// ── Legacy header-less behavior ───────────────────────────────

describe("standalone-broker-client legacy header contract", () => {
  it("does NOT send an A2A-Version header on createTask", async () => {
    const { fetchImpl, calls } = makeFetchStub(() => jsonResponse(legacyTaskRecord()));
    const client = createA2ABrokerClient({ baseUrl: BASE, fetchImpl });

    await client.createTask({
      intent: "chat",
      requester: { id: "hub-session", kind: "session", role: "hub" },
      target: { id: "worker-a", kind: "node" },
      message: "hello",
    });

    assert.equal(calls.length, 1);
    const headers = calls[0]!.headers;
    // Legacy client: no protocol-version negotiation header in any casing.
    assert.equal(headers.has("a2a-version"), false);
    assert.equal(headers.has("A2A-Version"), false);
    assert.equal(headers.has("x-a2a-version"), false);
    // It DOES send the legacy edge/requester headers + JSON content type.
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("accept"), "application/json");
    assert.match(headers.get("user-agent") ?? "", /openclaw-a2a-standalone-broker/);
  });

  it("does NOT send an A2A-Version header on GET verbs (health, getTask)", async () => {
    const { fetchImpl, calls } = makeFetchStub((req) => {
      if (req.url.endsWith("/health")) {
        return jsonResponse({ ok: true, service: "broker", publicBaseUrl: BASE });
      }
      return jsonResponse(legacyTaskRecord());
    });
    const client = createA2ABrokerClient({ baseUrl: BASE, fetchImpl });

    await client.health();
    await client.getTask("task-1");

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.headers.has("a2a-version"), false);
      assert.equal(call.headers.has("x-a2a-version"), false);
    }
  });

  it("forwards edge secret and requester identity as legacy x-a2a-* headers", async () => {
    const { fetchImpl, calls } = makeFetchStub(() => jsonResponse(legacyTaskRecord()));
    const client = createA2ABrokerClient({
      baseUrl: BASE,
      edgeSecret: "edge-secret-123",
      requester: { id: "hub-session", kind: "session", role: "hub" },
      fetchImpl,
    });

    await client.getTask("task-1");

    const headers = calls[0]!.headers;
    assert.equal(headers.get("x-a2a-edge-secret"), "edge-secret-123");
    assert.equal(headers.get("x-a2a-requester-id"), "hub-session");
    assert.equal(headers.get("x-a2a-requester-kind"), "session");
    assert.equal(headers.get("x-a2a-requester-role"), "hub");
    assert.equal(headers.has("a2a-version"), false);
  });
});

// ── Legacy envelope parsing ───────────────────────────────────

describe("standalone-broker-client legacy envelope parsing", () => {
  it("parses the legacy flat task-record envelope returned by createTask", async () => {
    const record = legacyTaskRecord({ status: "claimed", claimedBy: "worker-a" });
    const { fetchImpl } = makeFetchStub(() => jsonResponse(record));
    const client = createA2ABrokerClient({ baseUrl: BASE, fetchImpl });

    const result = await client.createTask({
      intent: "chat",
      requester: { id: "hub-session", kind: "session", role: "hub" },
      target: { id: "worker-a", kind: "node" },
      message: "hi",
    });

    assert.equal(result.id, "task-1");
    assert.equal(result.status, "claimed");
    assert.equal(result.claimedBy, "worker-a");
    assert.equal(result.targetNodeId, "worker-a");
  });

  it("parses the legacy task-record returned by getTask", async () => {
    const record = legacyTaskRecord({ status: "succeeded", result: { summary: "done" } });
    const { fetchImpl } = makeFetchStub(() => jsonResponse(record));
    const client = createA2ABrokerClient({ baseUrl: BASE, fetchImpl });

    const result = await client.getTask("task-1");
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.result, { summary: "done" });
  });

  it("rejects a malformed (non-JSON) broker body with A2ABrokerMalformedResponseError", async () => {
    const { fetchImpl } = makeFetchStub(
      () => new Response("<html>oops</html>", { status: 200 }),
    );
    const client = createA2ABrokerClient({ baseUrl: BASE, fetchImpl });

    await assert.rejects(() => client.getTask("task-1"), (err: unknown) => {
      assert.ok(err instanceof A2ABrokerMalformedResponseError);
      assert.equal(err.status, 200);
      assert.match(err.bodyText, /oops/);
      return true;
    });
  });
});

// ── Error envelope surfacing (broker JSON-RPC error -> plugin) ─

describe("standalone-broker-client error envelope surfacing", () => {
  it("surfaces a broker { error: { code, message } } envelope as A2ABrokerClientError", async () => {
    const { fetchImpl } = makeFetchStub(() =>
      jsonResponse({ error: { code: "task_not_found", message: "no such task" } }, 404),
    );
    const client = createA2ABrokerClient({ baseUrl: BASE, fetchImpl });

    await assert.rejects(() => client.getTask("task-1"), (err: unknown) => {
      assert.ok(err instanceof A2ABrokerClientError);
      assert.equal(err.status, 404);
      assert.equal(err.code, "task_not_found");
      assert.equal(err.message, "no such task");
      assert.deepEqual(err.details, { error: { code: "task_not_found", message: "no such task" } });
      return true;
    });
  });

  it("falls back to a status-derived message when the error envelope lacks a message", async () => {
    const { fetchImpl } = makeFetchStub(() => jsonResponse({ error: { code: "boom" } }, 500));
    const client = createA2ABrokerClient({ baseUrl: BASE, fetchImpl });

    await assert.rejects(() => client.getTask("task-1"), (err: unknown) => {
      assert.ok(err instanceof A2ABrokerClientError);
      assert.equal(err.status, 500);
      assert.equal(err.code, "boom");
      assert.match(err.message, /500/);
      return true;
    });
  });

  it("treats a non-JSON error body on a JSON verb as a malformed response", async () => {
    // getTask JSON-parses the body before the ok-check, so a non-JSON error
    // body surfaces as A2ABrokerMalformedResponseError (not A2ABrokerClientError).
    const { fetchImpl } = makeFetchStub(
      () => new Response("rate limited", { status: 429 }),
    );
    const client = createA2ABrokerClient({ baseUrl: BASE, fetchImpl });

    await assert.rejects(() => client.getTask("task-1"), (err: unknown) => {
      assert.ok(err instanceof A2ABrokerMalformedResponseError);
      assert.equal(err.status, 429);
      assert.match(err.bodyText, /rate limited/);
      return true;
    });
  });

  it("surfaces a JSON string error body as the message", async () => {
    // When the broker returns a bare JSON string body, buildClientError uses it
    // verbatim as the A2ABrokerClientError message.
    const { fetchImpl } = makeFetchStub(() => jsonResponse("rate limited", 429));
    const client = createA2ABrokerClient({ baseUrl: BASE, fetchImpl });

    await assert.rejects(() => client.relayTerminalProjection({ taskId: "task-1" }), (err: unknown) => {
      assert.ok(err instanceof A2ABrokerClientError);
      assert.equal(err.status, 429);
      assert.equal(err.message, "rate limited");
      return true;
    });
  });

  it("maps a broker JSON-RPC error result on peerStatus into A2ABrokerClientError", async () => {
    const { fetchImpl } = makeFetchStub(() =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "peer offline", data: { brokerCode: "peer_unreachable" } },
      }),
    );
    const client = createA2ABrokerClient({ baseUrl: BASE, fetchImpl });

    await assert.rejects(() => client.peerStatus({ target: "worker-a" }), (err: unknown) => {
      assert.ok(err instanceof A2ABrokerClientError);
      assert.equal(err.message, "peer_unreachable");
      return true;
    });
  });

  it("returns the JSON-RPC result envelope on a successful peerStatus", async () => {
    const { fetchImpl, calls } = makeFetchStub(() =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: { status: "online" } }),
    );
    const client = createA2ABrokerClient({ baseUrl: BASE, fetchImpl });

    const result = await client.peerStatus({ target: "worker-a" });
    assert.deepEqual(result, { status: "online" });
    // peerStatus is a JSON-RPC POST and still must not negotiate a protocol version.
    assert.equal(calls[0]!.headers.has("a2a-version"), false);
    assert.equal(calls[0]!.body && (calls[0]!.body as Record<string, unknown>).method, "PeerStatus");
  });
});

// ── Base URL normalization (pure utility) ─────────────────────

describe("normalizeA2ABrokerBaseUrl", () => {
  it("strips trailing slashes and preserves scheme+host", () => {
    assert.equal(normalizeA2ABrokerBaseUrl("https://broker.example/"), "https://broker.example");
    assert.equal(normalizeA2ABrokerBaseUrl("https://broker.example///"), "https://broker.example");
    assert.equal(
      normalizeA2ABrokerBaseUrl("https://broker.example/a2a/"),
      "https://broker.example/a2a",
    );
  });

  it("rejects empty and non-http(s) URLs", () => {
    assert.throws(() => normalizeA2ABrokerBaseUrl("   "), /required/);
    assert.throws(() => normalizeA2ABrokerBaseUrl("ftp://broker.example"), /http or https/);
  });
});
