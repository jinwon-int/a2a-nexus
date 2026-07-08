import assert from "node:assert/strict";
import test from "node:test";

import {
  ENDPOINT_GROUPS,
  REQUEST_ROUTE_GROUPS,
  classifyEndpointGroup,
  classifyRequestRoute,
} from "./route-classification.js";

function segments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

test("route classification group inventories keep expected observability labels", () => {
  assert.ok(ENDPOINT_GROUPS.includes("workers.assignment-events"));
  assert.ok(ENDPOINT_GROUPS.includes("sidecar"));
  assert.ok(REQUEST_ROUTE_GROUPS.includes("a2a.jsonrpc"));
  assert.ok(REQUEST_ROUTE_GROUPS.includes("terminal-brief.closeout"));
  assert.ok(REQUEST_ROUTE_GROUPS.includes("proposals.artifacts"));
});

test("classifyEndpointGroup preserves coarse endpoint attribution", () => {
  assert.equal(classifyEndpointGroup("GET", "/livez", segments("/livez")), "livez");
  assert.equal(classifyEndpointGroup("GET", "/.well-known/agent-card.json", segments("/.well-known/agent-card.json")), "well-known");
  assert.equal(classifyEndpointGroup("GET", "/dashboard/status", segments("/dashboard/status")), "dashboard");
  assert.equal(classifyEndpointGroup("GET", "/terminal-brief/sidecar/abc", segments("/terminal-brief/sidecar/abc")), "sidecar");
  assert.equal(classifyEndpointGroup("GET", "/terminal-brief/inbox", segments("/terminal-brief/inbox")), "terminal-brief");
  assert.equal(classifyEndpointGroup("POST", "/workers/register", segments("/workers/register")), "workers.register");
  assert.equal(classifyEndpointGroup("GET", "/workers/worker-a", segments("/workers/worker-a")), "workers.detail");
  assert.equal(classifyEndpointGroup("POST", "/workers/worker-a/heartbeat", segments("/workers/worker-a/heartbeat")), "workers.heartbeat");
  assert.equal(classifyEndpointGroup("GET", "/a2a/workers/worker-a/assignment-events", segments("/a2a/workers/worker-a/assignment-events")), "workers.assignment-events");
  assert.equal(classifyEndpointGroup("POST", "/a2a/jsonrpc", segments("/a2a/jsonrpc")), "a2a");
  assert.equal(classifyEndpointGroup("POST", "/wave-plans", segments("/wave-plans")), "wave-plan");
  assert.equal(classifyEndpointGroup("POST", "/wave-plans/wave-1/advance", segments("/wave-plans/wave-1/advance")), "wave-plan");
  assert.equal(classifyEndpointGroup("GET", "/unknown", segments("/unknown")), "other");
});

test("classifyRequestRoute preserves fine-grained route attribution", () => {
  const cases: Array<[string | undefined, string, string]> = [
    ["GET", "/livez", "livez"],
    ["GET", "/health", "health"],
    ["GET", "/schedz", "schedz"],
    ["GET", "/.well-known/agent-card.json", "well-known"],
    ["GET", "/dashboard", "dashboard"],
    ["GET", "/terminal-brief/sidecar/a", "sidecar"],
    ["GET", "/terminal-brief/closeout/1", "terminal-brief.closeout"],
    ["GET", "/terminal-brief/inbox", "terminal-brief.inbox"],
    ["GET", "/complexity", "complexity"],
    ["POST", "/wave-plans", "wave-plan"],
    ["POST", "/wave-plans/wave-1/advance", "wave-plan"],
    ["GET", "/wave-plans/wave-1", "wave-plan"],
    ["GET", "/workers", "workers.list"],
    ["GET", "/workers/capacity", "workers.capacity"],
    ["POST", "/workers/register", "workers.register"],
    ["POST", "/workers/subagent-orchestration/plan", "workers.subagent-orchestration.plan"],
    ["GET", "/workers/worker-a", "workers.detail"],
    ["POST", "/workers/worker-a/heartbeat", "workers.heartbeat"],
    ["GET", "/a2a/workers/worker-a/assignment-events", "workers.assignment-events"],
    ["POST", "/a2a/jsonrpc/", "a2a.jsonrpc"],
    ["GET", "/a2a/tasks/task-a/events", "a2a.tasks.events"],
    ["GET", "/a2a/tasks/terminal-outbox", "a2a.tasks.terminal-outbox"],
    ["POST", "/a2a/tasks/terminal-outbox/receipt", "a2a.tasks.terminal-outbox.receipt"],
    ["POST", "/a2a/tasks/terminal-outbox/ack", "a2a.tasks.terminal-outbox.ack"],
    ["GET", "/a2a/operator/events", "a2a.operator-events"],
    ["POST", "/a2a/cross-broker/terminal-briefs", "a2a.cross-broker.terminal-briefs"],
    ["GET", "/tasks", "tasks.list"],
    ["POST", "/tasks", "tasks.create"],
    ["POST", "/tasks/requeue_stale", "tasks.requeue-stale"],
    ["GET", "/tasks/diagnostics", "tasks.diagnostics"],
    ["POST", "/tasks/task-a/start", "tasks.start"],
    ["POST", "/tasks/task-a/checkpoint", "tasks.heartbeat"],
    ["POST", "/tasks/task-a/resume", "tasks.heartbeat"],
    ["POST", "/tasks/task-a/complete", "tasks.complete"],
    ["POST", "/tasks/task-a/evidence", "tasks.evidence"],
    ["POST", "/tasks/task-a/fail", "tasks.fail"],
    ["POST", "/tasks/task-a/approve", "tasks.approve"],
    ["POST", "/tasks/task-a/reject_approval", "tasks.reject-approval"],
    ["POST", "/tasks/task-a/cancel", "tasks.cancel"],
    ["POST", "/tasks/task-a/reassign", "tasks.reassign"],
    ["POST", "/tasks/task-a/wake", "tasks.wake"],
    ["GET", "/tasks/task-a", "tasks.detail"],
    ["POST", "/operator/task-report", "operator.task-report"],
    ["POST", "/operator/cleanup/plan", "operator.cleanup.plan"],
    ["POST", "/operator/cleanup/execute", "operator.cleanup.execute"],
    ["GET", "/alerts", "operator.alerts"],
    ["GET", "/cleanup/candidates", "operator.cleanup.candidates"],
    ["GET", "/control-tower", "operator.control-tower"],
    ["GET", "/release/evidence", "operator.release-evidence"],
    ["GET", "/exchanges", "exchanges.list"],
    ["POST", "/exchanges", "exchanges.create"],
    ["GET", "/exchanges/ex-a/messages", "exchanges.messages"],
    ["GET", "/proposals", "proposals.list"],
    ["POST", "/proposals", "proposals.create"],
    ["POST", "/proposals/pr-a/apply", "proposals.apply"],
    ["POST", "/proposals/pr-a/validate", "proposals.validate"],
    ["GET", "/proposals/pr-a/artifacts", "proposals.artifacts"],
    ["GET", "/proposals/pr-a", "proposals.detail"],
    ["GET", "/audit", "audit"],
    ["GET", "/unknown", "other"],
  ];

  for (const [method, pathname, expected] of cases) {
    assert.equal(classifyRequestRoute(method, pathname, segments(pathname)), expected, pathname);
  }
});
