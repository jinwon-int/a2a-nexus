export const ENDPOINT_GROUPS = [
  "livez",
  "health",
  "schedz",
  "workers.list",
  "workers.capacity",
  "workers.register",
  "workers.detail",
  "workers.heartbeat",
  "workers.assignment-events",
  "workers.subagent-orchestration.plan",
  "worker",
  "a2a",
  "well-known",
  "dashboard",
  "terminal-brief",
  "complexity",
  "wave-plan",
  "review-lineage",
  "sidecar",
  "other",
] as const;

export type EndpointGroup = (typeof ENDPOINT_GROUPS)[number];

export const REQUEST_ROUTE_GROUPS = [
  "livez",
  "health",
  "schedz",
  "workers.list",
  "workers.capacity",
  "workers.register",
  "workers.detail",
  "workers.heartbeat",
  "workers.assignment-events",
  "workers.subagent-orchestration.plan",
  "a2a.jsonrpc",
  "a2a.tasks.events",
  "a2a.tasks.terminal-outbox",
  "a2a.tasks.terminal-outbox.receipt",
  "a2a.tasks.terminal-outbox.ack",
  "a2a.tasks.terminal-events",
  "a2a.operator-events",
  "a2a.cross-broker.terminal-briefs",
  "a2a",
  "tasks.list",
  "tasks.create",
  "tasks.requeue-stale",
  "tasks.diagnostics",
  "tasks.detail",
  "tasks.start",
  "tasks.heartbeat",
  "tasks.complete",
  "tasks.evidence",
  "tasks.fail",
  "tasks.approve",
  "tasks.reject-approval",
  "tasks.cancel",
  "tasks.reassign",
  "tasks.wake",
  "operator.task-report",
  "operator.cleanup.plan",
  "operator.cleanup.execute",
  "operator.alerts",
  "operator.cleanup.candidates",
  "operator.control-tower",
  "operator.release-evidence",
  "exchanges.list",
  "exchanges.create",
  "exchanges.messages",
  "proposals.list",
  "proposals.detail",
  "proposals.create",
  "proposals.apply",
  "proposals.validate",
  "proposals.artifacts",
  "audit",
  "well-known",
  "dashboard",
  "terminal-brief",
  "terminal-brief.inbox",
  "terminal-brief.closeout",
  "complexity",
  "wave-plan",
  "review-lineage",
  "sidecar",
  "other",
] as const;

export type RequestRouteGroup = (typeof REQUEST_ROUTE_GROUPS)[number];

export function classifyEndpointGroup(method: string | undefined, pathname: string, segments: string[]): EndpointGroup {
  if (pathname === "/livez") return "livez";
  if (pathname === "/health") return "health";
  if (pathname === "/schedz") return "schedz";
  if (pathname === "/.well-known/agent-card.json" || pathname.startsWith("/.well-known/")) return "well-known";
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return "dashboard";
  if (pathname.startsWith("/terminal-brief/sidecar") || pathname.includes("/sidecar/")) return "sidecar";
  if (pathname.startsWith("/terminal-brief")) return "terminal-brief";
  if (pathname.startsWith("/complexity")) return "complexity";
  if (pathname === "/wave-plans" || pathname.startsWith("/wave-plans/")) return "wave-plan";
  if (pathname === "/review-lineages" || pathname.startsWith("/review-lineages/")) return "review-lineage";
  if (method === "GET" && pathname === "/workers") return "workers.list";
  if (method === "GET" && pathname === "/workers/capacity") return "workers.capacity";
  if (method === "POST" && pathname === "/workers/register") return "workers.register";
  if (method === "POST" && pathname === "/workers/subagent-orchestration/plan") {
    return "workers.subagent-orchestration.plan";
  }
  if (method === "GET" && segments[0] === "workers" && segments[1] && segments.length === 2) {
    return "workers.detail";
  }
  if (method === "POST" && segments[0] === "workers" && segments[1] && segments[2] === "heartbeat") {
    return "workers.heartbeat";
  }
  if (
    method === "GET" &&
    segments[0] === "a2a" &&
    segments[1] === "workers" &&
    segments[2] &&
    segments[3] === "assignment-events"
  ) {
    return "workers.assignment-events";
  }
  if (pathname.startsWith("/workers") || pathname.startsWith("/a2a/workers")) return "worker";
  if (pathname.startsWith("/a2a/")) return "a2a";
  return "other";
}

export function classifyRequestRoute(method: string | undefined, pathname: string, segments: string[]): RequestRouteGroup {
  if (pathname === "/livez") return "livez";
  if (pathname === "/health") return "health";
  if (pathname === "/schedz") return "schedz";
  if (pathname === "/.well-known/agent-card.json" || pathname.startsWith("/.well-known/")) return "well-known";
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return "dashboard";
  if (pathname.startsWith("/terminal-brief/sidecar") || pathname.includes("/sidecar/")) return "sidecar";
  if (pathname.startsWith("/terminal-brief/closeout")) return "terminal-brief.closeout";
  if (pathname === "/terminal-brief/inbox") return "terminal-brief.inbox";
  if (pathname.startsWith("/terminal-brief")) return "terminal-brief";
  if (pathname.startsWith("/complexity")) return "complexity";
  if (pathname === "/wave-plans" || pathname.startsWith("/wave-plans/")) return "wave-plan";
  if (pathname === "/review-lineages" || pathname.startsWith("/review-lineages/")) return "review-lineage";
  if (method === "GET" && pathname === "/workers") return "workers.list";
  if (method === "GET" && pathname === "/workers/capacity") return "workers.capacity";
  if (method === "POST" && pathname === "/workers/register") return "workers.register";
  if (method === "POST" && pathname === "/workers/subagent-orchestration/plan") {
    return "workers.subagent-orchestration.plan";
  }
  if (method === "GET" && segments[0] === "workers" && segments[1] && segments.length === 2) {
    return "workers.detail";
  }
  if (method === "POST" && segments[0] === "workers" && segments[1] && segments[2] === "heartbeat") {
    return "workers.heartbeat";
  }
  if (
    method === "GET" &&
    segments[0] === "a2a" &&
    segments[1] === "workers" &&
    segments[2] &&
    segments[3] === "assignment-events"
  ) {
    return "workers.assignment-events";
  }
  // Trailing-slash tolerant: A2A clients built on httpx-style base_url
  // merging (the official TCK included) post to "/a2a/jsonrpc/".
  if (pathname === "/a2a/jsonrpc" || pathname === "/a2a/jsonrpc/") return "a2a.jsonrpc";
  if (pathname === "/a2a/tasks/terminal-outbox/receipt") return "a2a.tasks.terminal-outbox.receipt";
  if (pathname === "/a2a/tasks/terminal-outbox/ack") return "a2a.tasks.terminal-outbox.ack";
  if (pathname === "/a2a/tasks/terminal-outbox") return "a2a.tasks.terminal-outbox";
  if (pathname === "/a2a/tasks/terminal-events") return "a2a.tasks.terminal-events";
  if (pathname === "/a2a/operator/events") return "a2a.operator-events";
  if (pathname === "/a2a/cross-broker/terminal-briefs") return "a2a.cross-broker.terminal-briefs";
  if (
    method === "GET" &&
    segments[0] === "a2a" &&
    segments[1] === "tasks" &&
    segments[2] &&
    segments[3] === "events"
  ) {
    return "a2a.tasks.events";
  }
  if (pathname.startsWith("/a2a/")) return "a2a";
  if (method === "GET" && pathname === "/tasks") return "tasks.list";
  if (method === "POST" && pathname === "/tasks") return "tasks.create";
  if (method === "POST" && pathname === "/tasks/requeue_stale") return "tasks.requeue-stale";
  if (method === "GET" && pathname === "/tasks/diagnostics") return "tasks.diagnostics";
  if (segments[0] === "tasks" && segments[1]) {
    if (segments[2] === "start") return "tasks.start";
    if (segments[2] === "heartbeat") return "tasks.heartbeat";
    if (segments[2] === "checkpoint") return "tasks.heartbeat";
    if (segments[2] === "resume") return "tasks.heartbeat";
    if (segments[2] === "complete") return "tasks.complete";
    if (segments[2] === "evidence") return "tasks.evidence";
    if (segments[2] === "fail") return "tasks.fail";
    if (segments[2] === "approve") return "tasks.approve";
    if (segments[2] === "reject_approval") return "tasks.reject-approval";
    if (segments[2] === "cancel") return "tasks.cancel";
    if (segments[2] === "reassign") return "tasks.reassign";
    if (segments[2] === "wake") return "tasks.wake";
    return "tasks.detail";
  }
  if (pathname === "/operator/task-report") return "operator.task-report";
  if (pathname === "/operator/cleanup/plan") return "operator.cleanup.plan";
  if (pathname === "/operator/cleanup/execute") return "operator.cleanup.execute";
  if (pathname === "/alerts") return "operator.alerts";
  if (pathname === "/cleanup/candidates") return "operator.cleanup.candidates";
  if (pathname === "/control-tower") return "operator.control-tower";
  if (pathname === "/release/evidence") return "operator.release-evidence";
  if (method === "GET" && pathname === "/exchanges") return "exchanges.list";
  if (method === "POST" && pathname === "/exchanges") return "exchanges.create";
  if (segments[0] === "exchanges" && segments[1] && segments[2] === "messages") return "exchanges.messages";
  if (method === "GET" && pathname === "/proposals") return "proposals.list";
  if (method === "POST" && pathname === "/proposals") return "proposals.create";
  if (segments[0] === "proposals" && segments[1]) {
    if (segments[2] === "apply") return "proposals.apply";
    if (segments[2] === "validate") return "proposals.validate";
    if (segments[2] === "artifacts") return "proposals.artifacts";
    return "proposals.detail";
  }
  if (pathname === "/audit") return "audit";
  return "other";
}
