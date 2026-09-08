import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRouteIndex,
  entryRateLimitBucket,
  lookupRoute,
  matchRoutePattern,
  type BrokerRouteEntry,
} from "./route-table.js";

const noop = async (): Promise<boolean> => true;

function entry(overrides: Partial<BrokerRouteEntry> & { method: string; pattern: readonly string[] }): BrokerRouteEntry {
  return {
    route: "other",
    group: "other",
    handle: noop,
    ...overrides,
  };
}

test("matchRoutePattern matches fixed-length literals and captures params", () => {
  assert.deepEqual(matchRoutePattern(["tasks"], ["tasks"]), {});
  assert.deepEqual(matchRoutePattern(["tasks", ":id", "claim"], ["tasks", "t-1", "claim"]), { id: "t-1" });
  assert.equal(matchRoutePattern(["tasks", ":id"], ["tasks", "a", "b"]), null);
  assert.equal(matchRoutePattern(["tasks"], ["tasks", "a"]), null);
  assert.equal(matchRoutePattern(["tasks", ":id"], ["workers", "a"]), null);
  assert.equal(matchRoutePattern([], ["tasks"]), null);
  assert.deepEqual(matchRoutePattern([], []), {});
});

test("lookupRoute keys on method and first segment, preserving insertion order", () => {
  const index = buildRouteIndex([
    entry({ method: "GET", pattern: ["tasks"], route: "tasks.list" }),
    entry({ method: "GET", pattern: ["tasks", ":id"], route: "tasks.detail" }),
    entry({ method: "POST", pattern: ["tasks", ":id", "claim"], route: "tasks.detail", drainRefused: true }),
  ]);

  const list = lookupRoute(index, "GET", ["tasks"]);
  assert.equal(list?.entry.route, "tasks.list");

  const detail = lookupRoute(index, "GET", ["tasks", "t-9"]);
  assert.equal(detail?.entry.route, "tasks.detail");
  assert.deepEqual(detail?.params, { id: "t-9" });

  const wrongMethod = lookupRoute(index, "PUT", ["tasks", "t-9"]);
  assert.equal(wrongMethod, null);

  const unknownPrefix = lookupRoute(index, "GET", ["zzz"]);
  assert.equal(unknownPrefix, null);

  const claim = lookupRoute(index, "POST", ["tasks", "t-9", "claim"]);
  assert.equal(claim?.entry.drainRefused, true);
});

test("lookupRoute falls back to wildcard-method entries after exact-method entries", () => {
  const index = buildRouteIndex([
    entry({ method: "GET", pattern: ["dag", "admissions"], route: "wave-plan-dag-v2" }),
    entry({
      method: "*",
      pattern: ["dag", ":rest"],
      handle: () => {
        throw new Error("read-only surface");
      },
      route: "wave-plan-dag-v2",
    }),
  ]);

  // Exact method wins even though the wildcard entry also matches.
  assert.equal(lookupRoute(index, "GET", ["dag", "admissions"])?.entry.method, "GET");
  // Non-exact methods land on the wildcard entry.
  const post = lookupRoute(index, "POST", ["dag", "admissions"]);
  assert.equal(post?.entry.method, "*");
  assert.deepEqual(post?.params, { rest: "admissions" });
  // Wildcard entry still matches when no exact entry matches the path.
  assert.equal(lookupRoute(index, "GET", ["dag", "unknown"])?.entry.method, "*");
});

test("entryRateLimitBucket prefers the per-request refinement over the static field", () => {
  const ctx = {
    method: "GET",
    segments: ["tasks"],
    params: {},
    req: {} as never,
    url: new URL("http://localhost/tasks"),
    path: "/tasks",
  };
  const dynamic: BrokerRouteEntry = entry({
    method: "GET",
    pattern: ["tasks"],
    rateLimitBucket: "general",
    bucketOf: () => "worker",
  });
  assert.equal(entryRateLimitBucket(dynamic, ctx), "worker");

  const statik: BrokerRouteEntry = entry({ method: "GET", pattern: ["tasks"], rateLimitBucket: "worker" });
  assert.equal(entryRateLimitBucket(statik, ctx), "worker");

  const unset: BrokerRouteEntry = entry({ method: "GET", pattern: ["tasks"] });
  assert.equal(entryRateLimitBucket(unset, ctx), undefined);
});
