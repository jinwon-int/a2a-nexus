// Regression tests for the request-stage schema guard (B1a).
//
// Invariant under test: a payload the persisted-state schema would reject must
// be rejected at request time, so it can never reach the snapshot and break the
// next broker start (#1504, #1725).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import { BrokerError } from "./broker-error.js";
import { proposalSchema } from "./store-schemas.js";
import { serializeBrokerSnapshot, parseSnapshotPayload } from "./store-snapshot-io.js";
import { createProposalRequestSchema } from "./store-schemas.js";
import type { CreateProposalRequest } from "./types.js";

function baseProposal(overrides: Record<string, unknown> = {}): CreateProposalRequest {
  return {
    source: { id: "node-a", kind: "node", role: "operator" },
    target: { id: "node-b", kind: "node", role: "operator" },
    kind: "patch",
    summary: "tighten request validation",
    workspace: { nodeId: "node-b", workspaceId: "default" },
    patchText: "diff --git a b",
    ...overrides,
  } as CreateProposalRequest;
}

function expectBadRequest(fn: () => unknown, needle: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BrokerError, `expected BrokerError, got ${String(error)}`);
    assert.equal(error.code, "bad_request");
    assert.match(error.message, new RegExp(needle));
    return true;
  });
}

describe("request payload schemas derived from the store schemas", () => {
  it("rejects a proposal whose kind the snapshot schema would refuse (empty string)", () => {
    const broker = new InMemoryA2ABroker();
    const request = baseProposal({ kind: "" });
    // The store schema is the authority we are deriving from.
    assert.equal(proposalSchema.shape.kind.safeParse("").success, false);
    expectBadRequest(() => broker.createProposal(request), "kind");
    assert.equal(broker.listProposals().length, 0);
  });

  it("rejects a proposal whose kind is not a string", () => {
    const broker = new InMemoryA2ABroker();
    expectBadRequest(
      () => broker.createProposal(baseProposal({ kind: 7 as unknown as string })),
      "kind",
    );
  });

  it("rejects a proposal whose summary is not a string", () => {
    const broker = new InMemoryA2ABroker();
    expectBadRequest(
      () => broker.createProposal(baseProposal({ summary: { text: "x" } as unknown as string })),
      "summary",
    );
  });

  it("rejects an artifact attachment with a non-numeric sizeBytes", () => {
    const broker = new InMemoryA2ABroker();
    const proposal = broker.createProposal(baseProposal());
    expectBadRequest(
      () =>
        broker.attachArtifact(proposal.id, {
          kind: "log",
          uri: "https://example.invalid/log",
          sizeBytes: "big" as unknown as number,
        }),
      "sizeBytes",
    );
  });

  it("rejects a validation whose metrics carry non-scalar values", () => {
    const broker = new InMemoryA2ABroker();
    const proposal = broker.createProposal(baseProposal());
    expectBadRequest(
      () =>
        broker.submitValidationResult(proposal.id, {
          nodeId: "node-b",
          kind: "smoke",
          verdict: "pass",
          metrics: { nested: { count: 1 } } as unknown as Record<string, string>,
        }),
      "metrics",
    );
  });

  it("keeps the historical messages for the legacy required-field checks", () => {
    const broker = new InMemoryA2ABroker();
    expectBadRequest(
      () => broker.createProposal(baseProposal({ summary: "" })),
      "summary is required",
    );
    expectBadRequest(
      () => broker.createProposal(baseProposal({ patchText: undefined })),
      "patch proposals require patchText",
    );
  });

  it("accepts a valid proposal and the resulting snapshot still loads", () => {
    const broker = new InMemoryA2ABroker();
    const proposal = broker.createProposal(baseProposal({ rationale: "keeps loads green" }));
    assert.equal(proposal.kind, "patch");

    const payload = serializeBrokerSnapshot(broker.exportSnapshot());
    const reloaded = parseSnapshotPayload(payload, "memory://request-schema-test", 10_000_000);
    assert.equal(reloaded.proposals.length, 1);
    assert.equal(reloaded.proposals[0]?.id, proposal.id);
  });

  it("derives the request schema from the store schema (no request-only field drift)", () => {
    const storeFields = new Set(Object.keys(proposalSchema.shape));
    for (const field of Object.keys(createProposalRequestSchema.shape)) {
      assert.ok(
        storeFields.has(field),
        `request field ${field} is not present in the persisted proposal schema`,
      );
    }
  });
});
