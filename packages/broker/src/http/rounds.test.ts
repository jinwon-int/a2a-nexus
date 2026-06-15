import assert from "node:assert/strict";
import test from "node:test";
import type { ServerResponse } from "node:http";

import { handleRoundStatusRequest } from "./rounds.js";
import { BrokerError } from "../core/broker.js";
import type { RoundStatusSummary } from "../core/round-status.js";

function fakeRes(): ServerResponse & { _status?: number; _body?: string } {
  const res = {
    writeHead(status: number) {
      (res as { _status?: number })._status = status;
      return res;
    },
    end(body?: string) {
      (res as { _body?: string })._body = body;
      return res;
    },
  } as unknown as ServerResponse & { _status?: number; _body?: string };
  return res;
}

const summary: RoundStatusSummary = {
  parentRoundId: "round-1",
  total: 1,
  matched: 1,
  byStatus: { blocked: 0, queued: 0, claimed: 0, running: 0, succeeded: 1, failed: 0, canceled: 0 },
  completedCount: 1,
  pendingCount: 0,
  expectedButMissingCount: 0,
  completionRate: 1,
  lanes: [],
  incompleteTaskIds: [],
};

test("handleRoundStatusRequest decodes the id and returns the summary", () => {
  const res = fakeRes();
  let seen: string | undefined;
  handleRoundStatusRequest({
    res,
    rawParentRoundId: "round%2Done", // "round-one" once decoded
    getRoundStatus: (id) => {
      seen = id;
      return summary;
    },
  });
  assert.equal(seen, "round-one");
  assert.equal(res._status, 200);
  assert.equal(JSON.parse(res._body!).parentRoundId, "round-1");
});

test("handleRoundStatusRequest rejects malformed percent-encoding as bad_request (#743)", () => {
  const res = fakeRes();
  assert.throws(
    () =>
      handleRoundStatusRequest({
        res,
        rawParentRoundId: "%E0%A4%A", // invalid percent-encoding
        getRoundStatus: () => summary,
      }),
    (error: unknown) => error instanceof BrokerError && error.code === "bad_request",
  );
  // The handler must fail before writing a response.
  assert.equal(res._status, undefined);
});
