// #2339 PR-1b: parent round registry HTTP API — mint (local-origin only),
// anchors, read, role gate, and persistence through the running server.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { InMemoryA2ABroker } from "./core/broker.js";
import { jsonHeaders, startTestServer } from "./server-test-helpers.js";

const HUB = jsonHeaders({ "x-a2a-requester-id": "hub-alpha", "x-a2a-requester-role": "hub" });
const WORKER = jsonHeaders({ "x-a2a-requester-id": "worker-a", "x-a2a-requester-role": "analyst" });

const MINT_BODY = {
  parentRoundId: "brokeralpha-round-7",
  teamScope: "T1",
  handoffBrokerId: "brokerbeta",
  parentRoundTotal: 4,
  anchors: ["brokeralpha-parent-task-1"],
};

async function post(baseUrl: string, path: string, headers: Record<string, string>, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("PR-1b POST /a2a/parent-rounds mints a local-origin round, replays it, and refuses a different round", async () => {
  const server = await startTestServer({ brokerId: "brokeralpha" });
  try {
    const minted = await post(server.baseUrl, "/a2a/parent-rounds", HUB, MINT_BODY);
    assert.equal(minted.status, 201);
    assert.equal(minted.body.status, "minted");
    assert.deepEqual((minted.body.entry as Record<string, unknown>), {
      parentRoundId: "brokeralpha-round-7",
      originBrokerId: "brokeralpha",
      parentBrokerId: "brokeralpha",
      initiatingBrokerId: "brokeralpha",
      teamScope: "T1",
      handoffBrokerId: "brokerbeta",
      parentRoundTotal: 4,
      kind: "local-origin",
      mintedAt: (minted.body.entry as { mintedAt: string }).mintedAt,
      mintedBy: { requesterId: "hub-alpha", role: "hub" },
      anchors: ["brokeralpha-parent-task-1"],
    });

    const replayed = await post(server.baseUrl, "/a2a/parent-rounds", HUB, MINT_BODY);
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.status, "replayed");

    const conflict = await post(server.baseUrl, "/a2a/parent-rounds", HUB, { ...MINT_BODY, parentRoundTotal: 5 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.status, "conflict");
    assert.equal((conflict.body.entry as { parentRoundTotal: number }).parentRoundTotal, 4);

    const broker = server.runtime.broker as InMemoryA2ABroker;
    assert.equal(broker.getParentRound("brokeralpha-round-7")?.parentRoundTotal, 4);
  } finally {
    await server.close();
  }
});

test("PR-1b mint rejects foreign kinds, other origins, and malformed bodies", async () => {
  const server = await startTestServer({ brokerId: "brokeralpha" });
  try {
    for (const body of [
      { ...MINT_BODY, kind: "foreign-handoff" },
      { ...MINT_BODY, originBrokerId: "brokerbeta" },
      { ...MINT_BODY, parentBrokerId: "brokerbeta" },
      { ...MINT_BODY, parentRoundId: undefined },
      { ...MINT_BODY, parentRoundTotal: "4" },
      { ...MINT_BODY, parentRoundTotal: 0 },
      { ...MINT_BODY, anchors: [1] },
      [MINT_BODY],
    ]) {
      const response = await post(server.baseUrl, "/a2a/parent-rounds", HUB, body);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
    // Matching origin/parent claims are accepted.
    const agreeing = await post(server.baseUrl, "/a2a/parent-rounds", HUB, {
      ...MINT_BODY,
      originBrokerId: "brokeralpha",
      parentBrokerId: "brokeralpha",
      kind: "local-origin",
    });
    assert.equal(agreeing.status, 201);
  } finally {
    await server.close();
  }
});

test("PR-1b anchors and reads require a known round; workers are refused", async () => {
  const server = await startTestServer({ brokerId: "brokeralpha" });
  try {
    assert.equal((await post(server.baseUrl, "/a2a/parent-rounds", WORKER, MINT_BODY)).status, 401);
    await post(server.baseUrl, "/a2a/parent-rounds", HUB, MINT_BODY);

    const path = "/a2a/parent-rounds/brokeralpha-round-7/anchors";
    const added = await post(server.baseUrl, path, HUB, { anchor: "brokerbeta-child-1" });
    assert.equal(added.status, 201);
    assert.equal(added.body.status, "added");
    const present = await post(server.baseUrl, path, HUB, { anchor: "brokerbeta-child-1" });
    assert.equal(present.status, 200);
    assert.equal(present.body.status, "present");
    assert.equal((await post(server.baseUrl, "/a2a/parent-rounds/nope/anchors", HUB, { anchor: "x" })).status, 404);
    assert.equal((await post(server.baseUrl, path, HUB, { anchor: 7 })).status, 400);
    assert.equal((await post(server.baseUrl, path, WORKER, { anchor: "x" })).status, 401);

    const read = await fetch(`${server.baseUrl}/a2a/parent-rounds/brokeralpha-round-7`, { headers: HUB });
    assert.equal(read.status, 200);
    const readBody = await read.json() as { entry: { anchors: string[] } };
    assert.deepEqual(readBody.entry.anchors, ["brokeralpha-parent-task-1", "brokerbeta-child-1"]);
    assert.equal((await fetch(`${server.baseUrl}/a2a/parent-rounds/nope`, { headers: HUB })).status, 404);
    assert.equal((await fetch(`${server.baseUrl}/a2a/parent-rounds/brokeralpha-round-7`, { headers: WORKER })).status, 401);
  } finally {
    await server.close();
  }
});
