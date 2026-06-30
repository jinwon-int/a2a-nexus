import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { handleA2ATaskStreamRouteIfMatched } from "./a2a-task-stream-routes.js";

const here = dirname(fileURLToPath(import.meta.url));
const distRoot = join(here, "..");

function minimalContext(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    segments: ["a2a", "tasks", "task-1", "events"],
    req: {} as never,
    res: {} as never,
    url: new URL("http://broker.test/a2a/tasks/task-1/events"),
    broker: {} as never,
    enforceRequesterIdentity: false,
    requesterIdentity: null,
    taskSubscribeHeartbeatSec: 30,
    assertWorkerHttpSignatureRoute: async () => null,
    assertVerifiedWorkerMatches: () => undefined,
    ...overrides,
  } as never;
}

test("A2A task stream route dispatcher falls through non-GET and unknown A2A stream paths", async () => {
  assert.equal(await handleA2ATaskStreamRouteIfMatched(minimalContext()), false);
  assert.equal(
    await handleA2ATaskStreamRouteIfMatched(
      minimalContext({ method: "GET", segments: ["a2a", "tasks", "task-1", "events", "extra"] }),
    ),
    false,
  );
  assert.equal(
    await handleA2ATaskStreamRouteIfMatched(
      minimalContext({ method: "GET", segments: ["a2a", "workers", "worker-a", "assignment-events", "extra"] }),
    ),
    false,
  );
});

test("A2A task stream route extraction keeps dynamic route glue out of server.js", () => {
  const routeModule = readFileSync(join(here, "a2a-task-stream-routes.js"), "utf8");
  const serverModule = readFileSync(join(distRoot, "server.js"), "utf8");

  assert.match(routeModule, /workers\.assignment-events/);
  assert.match(routeModule, /handleWorkerAssignmentEventStream/);
  assert.match(routeModule, /handleTaskEventStream/);
  assert.doesNotMatch(routeModule, /from "\.\.\/server\.js"/);

  assert.match(serverModule, /handleA2ATaskStreamRouteIfMatched/);
  assert.doesNotMatch(serverModule, /segments\[3\] === "assignment-events"/);
  assert.doesNotMatch(serverModule, /segments\[3\] === "events"/);
});
