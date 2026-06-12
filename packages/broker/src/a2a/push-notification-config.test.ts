import assert from "node:assert/strict";
import { test } from "node:test";
import { PushConfigError, PushNotificationConfigStore } from "./push-notification-config.js";

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
