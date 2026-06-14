import assert from "node:assert/strict";
import { test } from "node:test";
import { PushConfigError, PushNotificationConfigStore, redactPushConfigSecrets } from "./push-notification-config.js";

test("push config store: create / get / list / delete lifecycle", () => {
  const store = new PushNotificationConfigStore();
  const created = store.create({ taskId: "t1", url: "https://example.com/hook", token: "abc" });
  assert.ok(created.id);
  assert.equal(created.taskId, "t1");
  assert.equal(created.url, "https://example.com/hook");
  assert.equal(created.token, "abc");

  assert.deepEqual(store.get("t1", created.id), created);
  assert.deepEqual(store.list("t1"), [created]);

  store.delete("t1", created.id);
  assert.throws(() => store.get("t1", created.id), PushConfigError);
  assert.deepEqual(store.list("t1"), []);
});

test("push config store validates url and surfaces typed errors", () => {
  const store = new PushNotificationConfigStore();
  assert.throws(() => store.create({ taskId: "", url: "https://x" }), /taskId is required/);
  assert.throws(() => store.create({ taskId: "t", url: "ftp://x" }), /http\(s\) URL/);
  assert.throws(
    () => store.create({ taskId: "t", url: "https://x.example", authentication: { credentials: { nested: "secret" } } }),
    /authentication\.credentials must be a string/,
  );
  assert.throws(
    () => store.create({ taskId: "t", url: "https://x.example", authentication: { schemes: "Bearer" } }),
    /authentication\.schemes must be an array of strings/,
  );
  assert.deepEqual(store.list("t"), [], "invalid auth input must not mutate the store before persistence");
  assert.throws(() => store.get("t", "nope"), (e: unknown) => e instanceof PushConfigError && e.code === "not_found");
  assert.throws(() => store.delete("t", "nope"), (e: unknown) => e instanceof PushConfigError && e.code === "not_found");
});

test("a client-supplied id is honored and re-create updates in place", () => {
  const store = new PushNotificationConfigStore();
  store.create({ taskId: "t2", id: "fixed", url: "https://a.example/1" });
  store.create({ taskId: "t2", id: "fixed", url: "https://a.example/2" });
  assert.equal(store.list("t2").length, 1);
  assert.equal(store.get("t2", "fixed").url, "https://a.example/2");
});

test("push config store snapshot / restore keeps raw secrets internal", () => {
  const store = new PushNotificationConfigStore();
  store.create({
    taskId: "t-snapshot",
    id: "cfg-snapshot",
    url: "https://example.com/snapshot-hook",
    token: "snapshot-secret-token",
    authentication: { schemes: ["Bearer"], credentials: "snapshot-secret-cred" },
  });

  const restored = new PushNotificationConfigStore([
    ...store.snapshot(),
    { taskId: "t-snapshot", id: "cfg-invalid", url: "ftp://example.com/hook", token: "invalid-secret" },
    {
      taskId: "t-snapshot",
      id: "cfg-invalid-auth",
      url: "https://example.com/invalid-auth",
      authentication: { credentials: { nested: "secret" } } as never,
    },
  ]);
  const config = restored.get("t-snapshot", "cfg-snapshot");
  assert.equal(config.token, "snapshot-secret-token");
  assert.equal(config.authentication?.credentials, "snapshot-secret-cred");
  assert.throws(() => restored.get("t-snapshot", "cfg-invalid"), PushConfigError);
  assert.throws(() => restored.get("t-snapshot", "cfg-invalid-auth"), PushConfigError);

  const redacted = redactPushConfigSecrets(config);
  assert.equal(redacted.token, "[redacted]");
  assert.equal(redacted.authentication?.credentials, "[redacted]");
});

test("push config store retainTasks drops configs for tasks pruned before listener registration", () => {
  const store = new PushNotificationConfigStore([
    { taskId: "retained", id: "cfg-retained", url: "https://example.com/retained", token: "keep-secret" },
    { taskId: "pruned", id: "cfg-pruned", url: "https://example.com/pruned", token: "drop-secret" },
  ]);
  const removed = store.retainTasks(["retained"]);
  assert.equal(removed, 1);
  assert.equal(store.get("retained", "cfg-retained").token, "keep-secret");
  assert.deepEqual(store.list("pruned"), []);
});

test("push configs are released when retention prunes their task (no secret outlives the task)", async () => {
  const { InMemoryA2ABroker } = await import("../core/broker.js");
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    retention: { terminalRetentionMs: 0, maxTerminalTasks: 0, maxTerminalExchanges: 0 },
  });
  broker.registerWorker({
    nodeId: "worker-prune",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
  const store = new PushNotificationConfigStore();
  broker.registerTaskPruneListener((prunedTaskIds) => {
    for (const taskId of prunedTaskIds) {
      store.clearTask(taskId);
    }
  });

  const task = broker.createTask({
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-prune", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-prune",
  });
  store.create({ taskId: task.id, url: "https://example.com/hook", token: "prune-secret" });
  assert.equal(store.list(task.id).length, 1);

  // Driving the task terminal triggers persistState -> retention; with a
  // zero retention window the task is pruned and the listener must release
  // its configs (and the secrets they hold).
  broker.cancelTask(task.id, { actor: { id: "hub-a", kind: "node", role: "hub" } });
  assert.equal(broker.getTask(task.id), null, "terminal task pruned by zero-retention policy");
  assert.deepEqual(store.list(task.id), [], "push configs must not outlive their task");
});
