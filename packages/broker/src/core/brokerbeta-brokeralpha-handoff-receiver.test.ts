import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseA2AAssignComment,
  redactHandoffReceiverSecrets,
  validatebrokerbetabrokeralphaHandoffCandidate,
} from "./brokerbeta-brokeralpha-handoff-receiver.js";
import type { brokerbetabrokeralphaHandoffCandidate } from "./brokerbeta-brokeralpha-handoff-receiver.js";

const allowedWorkers = ["workergamma", "workerdelta", "workerbeta", "workeralpha"] as const;

function validCandidate(overrides: Partial<brokerbetabrokeralphaHandoffCandidate> = {}): brokerbetabrokeralphaHandoffCandidate {
  return {
    brokerOfRecord: "brokeralpha",
    requestedByBroker: "brokerbeta",
    requestingAgent: "brokerbeta-coordinator",
    sourceTaskId: "brokerbeta-249-parent",
    targetTaskId: "brokeralpha-task-1",
    targetTeam: "team1",
    targetWorker: "workergamma",
    handoffReason: "Team1 closeout validation",
    status: "accepted",
    idempotencyKey: "brokerbeta-249:team1:workergamma",
    evidenceUrls: ["a2a-plane#249 (internal tracker, private)#issuecomment-1"],
    ...overrides,
  };
}

function validate(candidate: brokerbetabrokeralphaHandoffCandidate, knownIdempotencyKeys?: ReadonlySet<string>) {
  return validatebrokerbetabrokeralphaHandoffCandidate(candidate, { allowedWorkers, knownIdempotencyKeys });
}

describe("brokerbeta → brokeralpha handoff receiver validation", () => {
  it("accepts an explicit Team1 handoff manifest without mutating duplicate state", () => {
    const result = validate(validCandidate());

    assert.equal(result.ok, true);
    assert.equal(result.status, "accepted");
    assert.equal(result.sanitizedCandidate?.brokerOfRecord, "brokeralpha");
    assert.equal(result.sanitizedCandidate?.requestedByBroker, "brokerbeta");
    assert.equal(result.sanitizedCandidate?.targetTeam, "team1");
  });

  it("rejects duplicate comments by durable idempotency key", () => {
    const first = validCandidate();
    const known = new Set([first.idempotencyKey!]);
    const duplicate = validCandidate({ targetTaskId: undefined });

    const result = validate(duplicate, known);

    assert.equal(result.ok, false);
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "duplicate_idempotency_key");
  });

  it("rejects unknown Team1 workers before task creation", () => {
    const result = validate(validCandidate({ targetWorker: "not-a-team1-worker" }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown_target_worker");
  });

  it("rejects wrong targetTeam to preserve brokeralpha broker ownership boundaries", () => {
    const result = validate(validCandidate({ targetTeam: "team2" }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "target_team_must_be_team1");
  });

  it("rejects handoff comments without an idempotency key", () => {
    const result = validate(validCandidate({ idempotencyKey: undefined }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_idempotency_key");
  });

  it("redacts and rejects accidental edge secret leakage from evidence", () => {
    const result = validate(validCandidate({
      handoffReason: "do not leak A2A_BROKER_EDGE_SECRET=super-secret-value",
      evidenceUrls: ["https://example.test/?token=ok", "X-A2A-Edge-Secret: super-secret-value"],
    }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "secret_redacted");
    assert.equal(result.sanitizedCandidate?.handoffReason, "do not leak <redacted>");
    assert.equal(result.sanitizedCandidate?.evidenceUrls?.[1], "<redacted>");
    assert.doesNotMatch(JSON.stringify(result), /super-secret-value/);
  });

  it("parses /a2a assign comments into explicit receiver fields", () => {
    const parsed = parseA2AAssignComment(
      "/a2a assign workergamma brokerOfRecord=brokeralpha requestedByBroker=brokerbeta " +
      "requestingAgent=brokerbeta-coordinator sourceTaskId=brokerbeta-249-parent " +
      "targetTeam=team1 idempotencyKey=brokerbeta-249:team1:workergamma " +
      "handoffReason=\"closeout validation\" status=accepted",
    );

    assert.ok(parsed);
    assert.equal(parsed.targetWorker, "workergamma");
    assert.equal(parsed.brokerOfRecord, "brokeralpha");
    assert.equal(parsed.requestedByBroker, "brokerbeta");
    assert.equal(parsed.handoffReason, "closeout validation");
    assert.equal(validate(parsed).ok, true);
  });

  it("redacts common GitHub and bearer tokens from raw text", () => {
    const redacted = redactHandoffReceiverSecrets("Bearer abc.def gho_abcdefghijklmnopqrstuvwxyz");

    assert.equal(redacted, "<redacted> <redacted>");
  });
});
