import assert from "node:assert/strict";
import test from "node:test";

import {
  TERMINAL_BRIEF_CLOSEOUT_ROUTE_PATHS,
  handleTerminalBriefCloseoutRoutesIfMatched,
} from "./terminal-brief-routes.js";

test("Terminal Brief closeout route helper owns exactly the initial closeout POST route set", () => {
  assert.deepEqual(TERMINAL_BRIEF_CLOSEOUT_ROUTE_PATHS, [
    "/terminal-brief/closeout/gate",
    "/terminal-brief/closeout/approval-request",
    "/terminal-brief/closeout/approval-executor",
    "/terminal-brief/closeout/approval-dispatch",
    "/terminal-brief/closeout/approval-receipt",
    "/terminal-brief/closeout/finalizer-approval-status",
  ]);
});

test("Terminal Brief closeout route helper ignores unrelated routes", async () => {
  const handled = await handleTerminalBriefCloseoutRoutesIfMatched({
    method: "GET",
    path: "/terminal-brief/sidecar/dry-run-gate",
    req: {} as never,
    res: {} as never,
    url: new URL("http://localhost/terminal-brief/sidecar/dry-run-gate"),
    enforceRequesterIdentity: false,
    requesterIdentity: null,
  });

  assert.equal(handled, false);
});
