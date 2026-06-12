import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryA2ABroker } from "../core/broker.js";
import { startDefaultAgent, DEFAULT_AGENT_NODE_ID } from "./default-agent.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached in time");
}

test("default agent registers its worker and drives a queued task to completed", async () => {
  const broker = new InMemoryA2ABroker();
  const handle = startDefaultAgent(broker);
  try {
    assert.equal(handle.nodeId, DEFAULT_AGENT_NODE_ID);
    assert.ok(broker.getWorker(DEFAULT_AGENT_NODE_ID), "agent worker must be registered");

    const task = broker.createTask({
      intent: "chat",
      requester: { id: "client-1", kind: "service", role: "hub" },
      target: { id: DEFAULT_AGENT_NODE_ID, kind: "node", role: "analyst" },
      assignedWorkerId: DEFAULT_AGENT_NODE_ID,
      message: "echo me",
      payload: {},
    });

    await waitFor(() => broker.getTask(task.id)?.status === "succeeded");
    const done = broker.getTask(task.id);
    assert.equal(done?.status, "succeeded");
    assert.equal(done?.result?.summary, "echo me", "echo handler must echo the message");
  } finally {
    handle.stop();
  }
});

test("stop() detaches the drive loop", async () => {
  const broker = new InMemoryA2ABroker();
  const handle = startDefaultAgent(broker);
  handle.stop();

  const task = broker.createTask({
    intent: "chat",
    requester: { id: "client-2", kind: "service", role: "hub" },
    target: { id: DEFAULT_AGENT_NODE_ID, kind: "node", role: "analyst" },
    assignedWorkerId: DEFAULT_AGENT_NODE_ID,
    message: "should stay queued",
    payload: {},
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(broker.getTask(task.id)?.status, "queued", "stopped agent must not drive tasks");
});
