/**
 * Route entry factories for the table-driven router (#2079 A).
 *
 * One factory per legacy `handleXRouteIfMatched` module. Each factory pairs
 * the module's server-scoped dependencies (`Omit<Ctx, keyof
 * BrokerRequestContext>`) with one entry per (method, path shape) the module
 * dispatcher serves, so `server.ts` can build a single route index instead of
 * walking the 31-step handler chain.
 *
 * The entries carry the observability/rate-limit/drain metadata that used to
 * be re-derived per request by the `route-classification.ts` and
 * `classifyRateLimitBucket` if-chains; the snapshot test
 * (`route-table-equivalence.test.ts`) pins every entry's labels to the legacy
 * classifier output.
 *
 * Handlers delegate to the unchanged module dispatchers: an entry pattern may
 * be a slight superset of what its dispatcher finally accepts (the dispatcher
 * re-checks), and a `false` return makes the server fall through to the next
 * candidate entry — mirroring the legacy chain.
 */
import type { IncomingMessage } from "node:http";

import type { InMemoryA2ABroker } from "../core/broker.js";
import type { A2AWorkerRouteScope } from "../core/request-security.js";
import type { A2AHttpSignatureVerifiedWorker } from "../server.js";
import { handleA2AJsonRpcRouteIfMatched, type A2AJsonRpcRouteContext } from "./a2a-jsonrpc-route.js";
import { handleComplexityOrchestrationRoutesIfMatched, type ComplexityOrchestrationRoutesContext } from "./complexity-orchestration-routes.js";
import { handleWavePlanRoutesIfMatched, type WavePlanRouteContext } from "./wave-plan-routes.js";
import { handleWavePlanDagV2RoutesIfMatched } from "./wave-plan-dag-v2-routes.js";
import { handleReviewLineageRoutesIfMatched, type ReviewLineageRouteContext } from "./review-lineage-routes.js";
import { handleNclexEvaluationRoutesIfMatched, type NclexEvaluationRouteContext } from "./nclex-evaluation-routes.js";
import { handleA2ATaskStreamRouteIfMatched, type A2ATaskStreamRouteContext } from "./a2a-task-stream-routes.js";
import { handleA2ATerminalOutboxRouteIfMatched, type A2ATerminalOutboxRouteContext } from "./a2a-terminal-outbox-routes.js";
import {
  handleA2AStreamRouteIfMatched,
  type A2AStreamRouteContext,
} from "./a2a-stream-routes.js";
import { handleOperatorDashboardRouteIfMatched, type OperatorDashboardRouteContext } from "./operator-dashboard-routes.js";
import { handleOperatorReportingReadRouteIfMatched, type OperatorReportingReadRouteContext } from "./operator-reporting-read.js";
import { handleTerminalBriefCloseoutRoutesIfMatched, type TerminalBriefCloseoutRoutesContext } from "./terminal-brief-routes.js";
import { handleOperatorCleanupRouteIfMatched, type OperatorCleanupRouteContext } from "./operator-cleanup-routes.js";
import { handleOperatorDiagnosticsReadRouteIfMatched, type OperatorDiagnosticsReadRouteContext } from "./operator-diagnostics-read.js";
import { handleWorkersReadRouteIfMatched, type WorkersReadRouteContext } from "./workers-read.js";
import { handleWorkersWriteRouteIfMatched, type WorkersWriteRouteContext } from "./workers-write-routes.js";
import { handleExchangeRoutesIfMatched, type ExchangeRoutesContext } from "./exchanges-read.js";
import { handleConversationRoutesIfMatched, type ConversationRoutesContext } from "./conversations-routes.js";
import { handleConversationRelayRoutesIfMatched, type ConversationRelayRouteContext } from "./conversation-relay-routes.js";
import { handleProposalsReadRouteIfMatched, type ProposalsReadRouteContext } from "./proposals-read.js";
import { handleProposalsWriteRouteIfMatched, type ProposalsWriteRouteContext } from "./proposals-write-routes.js";
import { handleRoundStatusRouteIfMatched, type RoundStatusDispatchContext } from "./rounds.js";
import { handleTaskStatsRouteIfMatched, type TaskStatsRouteContext } from "./task-stats-routes.js";
import { handleWorkerLatencyStatsRouteIfMatched, type WorkerLatencyStatsRouteContext } from "./worker-latency-stats-routes.js";
import { handleTasksCollectionRouteIfMatched, type TasksCollectionRouteContext } from "./tasks-collection-routes.js";
import { handleTasksReadRouteIfMatched, type TasksReadRouteContext } from "./tasks-read.js";
import { handleTasksWakeRouteIfMatched, type TasksWakeRouteContext } from "./tasks-wake-routes.js";
import { handleTasksDecisionRouteIfMatched, type TasksDecisionRouteContext } from "./tasks-decision-routes.js";
import { handleTasksWorkerRouteIfMatched, type TasksWorkerRouteContext } from "./tasks-worker-routes.js";
import { handleAuditReadRouteIfMatched, type AuditReadRouteContext } from "./audit-read-route.js";
import { handleGitHubRouteIfMatched, type GitHubRouteContext } from "./github-routes.js";
import type {
  BrokerRequestContext,
  BrokerRouteEntry,
  RoutePattern,
} from "./route-table.js";
import type { EndpointGroup, RequestRouteGroup } from "./route-classification.js";

/** Signature-verification closures shared by worker-signed route modules. */
export interface WorkerSignatureRouteDeps {
  assertWorkerHttpSignatureRoute: (
    req: IncomingMessage,
    url: URL,
  ) => Promise<A2AHttpSignatureVerifiedWorker | null>;
  assertVerifiedWorkerMatches: (
    verified: A2AHttpSignatureVerifiedWorker | null,
    expectedWorkerId: string | undefined,
    operation: A2AWorkerRouteScope,
  ) => void;
}

type RouteDeps<Ctx> = Omit<Ctx, keyof BrokerRequestContext>;

function entry(
  method: string,
  pattern: RoutePattern,
  route: RequestRouteGroup,
  group: EndpointGroup,
  handle: (rc: BrokerRequestContext) => boolean | Promise<boolean>,
  extra: Partial<Pick<BrokerRouteEntry, "rateLimitBucket" | "drainRefused" | "bucketOf">> = {},
): BrokerRouteEntry {
  return { method, pattern, route, group, handle, ...extra };
}

/** Legacy `classifyRateLimitBucket`'s header lookup (first value, trimmed). */
function firstHeaderValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 1. A2A JSON-RPC transport
// ---------------------------------------------------------------------------

export function createA2AJsonRpcRouteEntries(
  deps: RouteDeps<A2AJsonRpcRouteContext>,
): BrokerRouteEntry[] {
  // Trailing-slash tolerant: A2A clients built on httpx-style base_url
  // merging (the official TCK included) post to "/a2a/jsonrpc/" — segment
  // matching treats both spellings identically.
  return [
    entry("POST", ["a2a", "jsonrpc"], "a2a.jsonrpc", "a2a", (rc) =>
      handleA2AJsonRpcRouteIfMatched({ ...rc, ...deps }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// 2. Complexity orchestration
// ---------------------------------------------------------------------------

export function createComplexityOrchestrationRouteEntries(
  deps: RouteDeps<ComplexityOrchestrationRoutesContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleComplexityOrchestrationRoutesIfMatched({ ...rc, ...deps });
  return [
    entry("POST", ["workers", "subagent-orchestration", "plan"], "workers.subagent-orchestration.plan", "workers.subagent-orchestration.plan", dispatch),
    entry("POST", ["complexity-orchestration", "recommendation"], "complexity", "complexity", dispatch),
    entry("POST", ["complexity-execution-plan", "draft"], "complexity", "complexity", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 3. Wave plan lifecycle
// ---------------------------------------------------------------------------

export function createWavePlanRouteEntries(deps: RouteDeps<WavePlanRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleWavePlanRoutesIfMatched({ ...rc, ...deps });
  return [
    entry("POST", ["wave-plans"], "wave-plan", "wave-plan", dispatch),
    entry("GET", ["wave-plans"], "wave-plan", "wave-plan", dispatch),
    entry("GET", ["wave-plans", ":id"], "wave-plan", "wave-plan", dispatch),
    entry("POST", ["wave-plans", ":id", ":action"], "wave-plan", "wave-plan", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 4. Wave plan DAG v2 (read-only surface; non-GET throws bad_request)
// ---------------------------------------------------------------------------

export function createWavePlanDagV2RouteEntries(deps: { broker: InMemoryA2ABroker }): BrokerRouteEntry[] {
  return [
    entry("GET", ["wave-plan-dag-v2", "admissions"], "wave-plan-dag-v2", "wave-plan-dag-v2", (rc) =>
      handleWavePlanDagV2RoutesIfMatched({ ...rc, broker: deps.broker }, rc.url),
    ),
    entry("GET", ["wave-plan-dag-v2", "rehearsals"], "wave-plan-dag-v2", "wave-plan-dag-v2", (rc) =>
      handleWavePlanDagV2RoutesIfMatched({ ...rc, broker: deps.broker }, rc.url),
    ),
    // Any other method on the v2 prefix fails loudly ("read-only") exactly as
    // the legacy prefix check did — including shapes the dispatcher does not
    // otherwise name.
    entry("*", ["wave-plan-dag-v2", "**"], "wave-plan-dag-v2", "wave-plan-dag-v2", (rc) =>
      handleWavePlanDagV2RoutesIfMatched({ ...rc, broker: deps.broker }, rc.url),
    ),
  ];
}

// ---------------------------------------------------------------------------
// 5. Review lineage
// ---------------------------------------------------------------------------

export function createReviewLineageRouteEntries(
  deps: RouteDeps<ReviewLineageRouteContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleReviewLineageRoutesIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["review-lineages"], "review-lineage", "review-lineage", dispatch),
    entry("POST", ["review-lineages"], "review-lineage", "review-lineage", dispatch),
    entry("GET", ["review-lineages", ":id", "**"], "review-lineage", "review-lineage", dispatch),
    entry("POST", ["review-lineages", ":id", "**"], "review-lineage", "review-lineage", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 6. NCLEX evaluation receipts (registered only when store + keyring exist)
// ---------------------------------------------------------------------------

export function createNclexEvaluationRouteEntries(
  deps: RouteDeps<NclexEvaluationRouteContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleNclexEvaluationRoutesIfMatched({ ...rc, ...deps });
  return [
    entry("POST", ["nclex-evaluations", "**"], "other", "other", dispatch),
    entry("GET", ["nclex-evaluations", "**"], "other", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 7. A2A task/worker SSE streams
// ---------------------------------------------------------------------------

export function createA2ATaskStreamRouteEntries(
  deps: RouteDeps<A2ATaskStreamRouteContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleA2ATaskStreamRouteIfMatched({ ...rc, ...deps });
  return [
    entry(
      "GET",
      ["a2a", "workers", ":id", "assignment-events"],
      "workers.assignment-events",
      "workers.assignment-events",
      dispatch,
      {
        // Worker bucket only when the requester header names the subscribed
        // worker (legacy classifyRateLimitBucket rule).
        bucketOf: ({ req, segments }) =>
          firstHeaderValue(req, "x-a2a-requester-id") === segments[2] ? "worker" : "general",
      },
    ),
    entry("GET", ["a2a", "tasks", ":id", "events"], "a2a.tasks.events", "a2a", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 8. Cross-broker terminal outbox
// ---------------------------------------------------------------------------

export function createA2ATerminalOutboxRouteEntries(
  deps: RouteDeps<A2ATerminalOutboxRouteContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleA2ATerminalOutboxRouteIfMatched({ ...rc, ...deps });
  return [
    entry("POST", ["a2a", "cross-broker", "terminal-briefs"], "a2a.cross-broker.terminal-briefs", "a2a", dispatch),
    entry("GET", ["a2a", "cross-broker", "terminal-briefs"], "a2a.cross-broker.terminal-briefs", "a2a", dispatch),
    entry("GET", ["a2a", "tasks", "terminal-outbox"], "a2a.tasks.terminal-outbox", "a2a", dispatch),
    entry("POST", ["a2a", "tasks", "terminal-outbox", "receipt"], "a2a.tasks.terminal-outbox.receipt", "a2a", dispatch),
    entry("POST", ["a2a", "tasks", "terminal-outbox", "ack"], "a2a.tasks.terminal-outbox.ack", "a2a", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 9. A2A SSE streams (terminal events, operator events)
// ---------------------------------------------------------------------------

export function createA2AStreamRouteEntries(deps: RouteDeps<A2AStreamRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleA2AStreamRouteIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["a2a", "tasks", "terminal-events"], "a2a.tasks.terminal-events", "a2a", dispatch),
    entry("GET", ["a2a", "operator", "events"], "a2a.operator-events", "a2a", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 10. Operator dashboard / control tower
// ---------------------------------------------------------------------------

export function createOperatorDashboardRouteEntries(
  deps: RouteDeps<OperatorDashboardRouteContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleOperatorDashboardRouteIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["dashboard"], "dashboard", "dashboard", dispatch),
    entry("GET", ["control-tower"], "operator.control-tower", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 11. Operator reporting reads (inbox, release evidence, task report)
// ---------------------------------------------------------------------------

export function createOperatorReportingReadRouteEntries(
  deps: RouteDeps<OperatorReportingReadRouteContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleOperatorReportingReadRouteIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["terminal-brief", "inbox"], "terminal-brief.inbox", "terminal-brief", dispatch),
    entry("GET", ["release", "evidence"], "operator.release-evidence", "other", dispatch),
    entry("GET", ["operator", "task-report"], "operator.task-report", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 12. Terminal brief closeout gates
// ---------------------------------------------------------------------------

export function createTerminalBriefCloseoutRouteEntries(
  deps: RouteDeps<TerminalBriefCloseoutRoutesContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleTerminalBriefCloseoutRoutesIfMatched({ ...rc, ...deps });
  return [
    entry("POST", ["terminal-brief", "closeout", "gate"], "terminal-brief.closeout", "terminal-brief", dispatch),
    entry("POST", ["terminal-brief", "closeout", "approval-request"], "terminal-brief.closeout", "terminal-brief", dispatch),
    entry("POST", ["terminal-brief", "closeout", "approval-executor"], "terminal-brief.closeout", "terminal-brief", dispatch),
    entry("POST", ["terminal-brief", "closeout", "approval-dispatch"], "terminal-brief.closeout", "terminal-brief", dispatch),
    entry("POST", ["terminal-brief", "closeout", "approval-receipt"], "terminal-brief.closeout", "terminal-brief", dispatch),
    entry("POST", ["terminal-brief", "closeout", "finalizer-approval-status"], "terminal-brief.closeout", "terminal-brief", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 13. Operator cleanup
// ---------------------------------------------------------------------------

export function createOperatorCleanupRouteEntries(
  deps: RouteDeps<OperatorCleanupRouteContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleOperatorCleanupRouteIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["operator", "cleanup", "plan"], "operator.cleanup.plan", "other", dispatch),
    entry("POST", ["operator", "cleanup", "execute"], "operator.cleanup.execute", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 14. Operator diagnostics reads (alerts, cleanup candidates)
// ---------------------------------------------------------------------------

export function createOperatorDiagnosticsReadRouteEntries(
  deps: RouteDeps<OperatorDiagnosticsReadRouteContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleOperatorDiagnosticsReadRouteIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["alerts"], "operator.alerts", "other", dispatch),
    entry("GET", ["cleanup", "candidates"], "operator.cleanup.candidates", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 15. Worker reads
// ---------------------------------------------------------------------------

export function createWorkersReadRouteEntries(deps: RouteDeps<WorkersReadRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleWorkersReadRouteIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["workers"], "workers.list", "workers.list", dispatch),
    entry("GET", ["workers", "capacity"], "workers.capacity", "workers.capacity", dispatch),
    entry("GET", ["workers", ":id"], "workers.detail", "workers.detail", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 16. Worker writes (register, heartbeat)
// ---------------------------------------------------------------------------

export function createWorkersWriteRouteEntries(deps: RouteDeps<WorkersWriteRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleWorkersWriteRouteIfMatched({ ...rc, ...deps });
  return [
    entry("POST", ["workers", "register"], "workers.register", "workers.register", dispatch, { rateLimitBucket: "worker" }),
    entry("POST", ["workers", ":id", "heartbeat"], "workers.heartbeat", "workers.heartbeat", dispatch, { rateLimitBucket: "worker" }),
  ];
}

// ---------------------------------------------------------------------------
// 17. Exchanges
// ---------------------------------------------------------------------------

export function createExchangeRouteEntries(deps: RouteDeps<ExchangeRoutesContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleExchangeRoutesIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["exchanges"], "exchanges.list", "other", dispatch),
    entry("POST", ["exchanges"], "exchanges.create", "other", dispatch),
    // Legacy dispatchers accept extra trailing segments after "messages".
    entry("GET", ["exchanges", ":id", "messages", "**"], "exchanges.messages", "other", dispatch),
    entry("POST", ["exchanges", ":id", "messages", "**"], "exchanges.messages", "other", dispatch),
    entry("GET", ["exchanges", ":id"], "other", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 18. Conversations
// ---------------------------------------------------------------------------

export function createConversationRouteEntries(deps: RouteDeps<ConversationRoutesContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleConversationRoutesIfMatched({ ...rc, ...deps });
  return [
    entry("POST", ["conversations"], "conversations.create", "other", dispatch),
    // GET /conversations (no id) throws not_found inside the dispatcher — keep
    // it routed there so the error contract is unchanged. The legacy
    // classifier has no label for the id-less form, so it stays "other".
    entry("GET", ["conversations"], "other", "other", dispatch),
    entry("GET", ["conversations", ":id"], "conversations.detail", "other", dispatch),
    entry("GET", ["conversations", ":id", "delivery"], "conversations.delivery", "other", dispatch),
    entry("GET", ["conversations", ":id", "inbox"], "conversations.inbox", "other", dispatch),
    entry("POST", ["conversations", ":id", "messages"], "conversations.messages", "other", dispatch),
    entry("POST", ["conversations", ":id", "messages", ":messageId", "processed"], "conversations.message.processed", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 19. Cross-broker conversation relay
// ---------------------------------------------------------------------------

export function createConversationRelayRouteEntries(
  deps: RouteDeps<ConversationRelayRouteContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleConversationRelayRoutesIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["peer", "conversations", "outbox"], "other", "other", dispatch),
    entry("POST", ["peer", "conversations", "relay"], "other", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 20. Proposal reads
// ---------------------------------------------------------------------------

export function createProposalsReadRouteEntries(deps: RouteDeps<ProposalsReadRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleProposalsReadRouteIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["proposals"], "proposals.list", "other", dispatch),
    entry("GET", ["proposals", ":id"], "proposals.detail", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 21. Proposal writes
// ---------------------------------------------------------------------------

export function createProposalsWriteRouteEntries(deps: RouteDeps<ProposalsWriteRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleProposalsWriteRouteIfMatched({ ...rc, ...deps });
  return [
    entry("POST", ["proposals"], "proposals.create", "other", dispatch),
    entry("POST", ["proposals", ":id", "artifacts"], "proposals.artifacts", "other", dispatch),
    entry("POST", ["proposals", ":id", "validate"], "proposals.validate", "other", dispatch),
    // approve/reject are not classifier labels — they fall under the
    // proposals.detail catch-all in the legacy route classifier too.
    entry("POST", ["proposals", ":id", "approve"], "proposals.detail", "other", dispatch),
    entry("POST", ["proposals", ":id", "reject"], "proposals.detail", "other", dispatch),
    entry("POST", ["proposals", ":id", "apply"], "proposals.apply", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 22. Round status
// ---------------------------------------------------------------------------

export function createRoundStatusRouteEntries(deps: RouteDeps<RoundStatusDispatchContext>): BrokerRouteEntry[] {
  return [
    entry("GET", ["rounds", ":id", "status"], "other", "other", (rc) =>
      handleRoundStatusRouteIfMatched({ ...rc, ...deps }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// 23. Task stats
// ---------------------------------------------------------------------------

export function createTaskStatsRouteEntries(deps: RouteDeps<TaskStatsRouteContext>): BrokerRouteEntry[] {
  return [
    entry("GET", ["stats", "tasks"], "other", "other", (rc) =>
      handleTaskStatsRouteIfMatched({ ...rc, ...deps }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// 24. Worker latency stats
// ---------------------------------------------------------------------------

export function createWorkerLatencyStatsRouteEntries(
  deps: RouteDeps<WorkerLatencyStatsRouteContext>,
): BrokerRouteEntry[] {
  return [
    entry("GET", ["stats", "workers"], "other", "other", (rc) =>
      handleWorkerLatencyStatsRouteIfMatched({ ...rc, ...deps }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// 25. Task collection (list / create / requeue stale)
// ---------------------------------------------------------------------------

export function createTasksCollectionRouteEntries(deps: RouteDeps<TasksCollectionRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleTasksCollectionRouteIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["tasks"], "tasks.list", "other", dispatch, {
      drainRefused: true,
      // Worker bucket when the poll names an assigned worker matching the
      // requester header (legacy classifyRateLimitBucket rule).
      bucketOf: ({ req, url }) => {
        const assignedWorkerId =
          url.searchParams.get("assignedWorkerId")?.trim() || url.searchParams.get("worker")?.trim();
        const requesterId = firstHeaderValue(req, "x-a2a-requester-id");
        return assignedWorkerId && requesterId === assignedWorkerId ? "worker" : "general";
      },
    }),
    entry("POST", ["tasks"], "tasks.create", "other", dispatch),
    entry("POST", ["tasks", "requeue_stale"], "tasks.requeue-stale", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 26. Task reads
// ---------------------------------------------------------------------------

export function createTasksReadRouteEntries(deps: RouteDeps<TasksReadRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleTasksReadRouteIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["tasks", "diagnostics"], "tasks.diagnostics", "other", dispatch),
    // The legacy classifier only labels the exact "/tasks/diagnostics" path;
    // the by-id variant falls through its tasks/:id switch to tasks.detail.
    entry("GET", ["tasks", ":id", "diagnostics"], "tasks.detail", "other", dispatch),
    entry("GET", ["tasks", ":id"], "tasks.detail", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 27. Task wake
// ---------------------------------------------------------------------------

export function createTasksWakeRouteEntries(deps: RouteDeps<TasksWakeRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleTasksWakeRouteIfMatched({ ...rc, ...deps });
  return [
    entry("POST", ["tasks", ":id", "wake", "plan"], "tasks.wake", "other", dispatch),
    entry("POST", ["tasks", ":id", "wake", "decision"], "tasks.wake", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 28. Operator task decisions
// ---------------------------------------------------------------------------

export function createTasksDecisionRouteEntries(deps: RouteDeps<TasksDecisionRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleTasksDecisionRouteIfMatched({ ...rc, ...deps });
  return [
    entry("POST", ["tasks", ":id", "resume"], "tasks.heartbeat", "other", dispatch),
    entry("POST", ["tasks", ":id", "approve"], "tasks.approve", "other", dispatch),
    // The dispatcher (and its tests) spell this route with a hyphen; the
    // underscore spelling classifies as tasks.reject-approval but 404s, so no
    // entry exists for it and the legacy classifier labels it on table miss.
    entry("POST", ["tasks", ":id", "reject-approval"], "tasks.detail", "other", dispatch),
    entry("POST", ["tasks", ":id", "cancel"], "tasks.cancel", "other", dispatch),
    entry("POST", ["tasks", ":id", "reassign"], "tasks.reassign", "other", dispatch),
  ];
}

// ---------------------------------------------------------------------------
// 29. Worker-signed task lifecycle
// ---------------------------------------------------------------------------

export function createTasksWorkerRouteEntries(deps: RouteDeps<TasksWorkerRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleTasksWorkerRouteIfMatched({ ...rc, ...deps });
  const workerBucket = { rateLimitBucket: "worker" } as const;
  return [
    // "claim" has no classifier label of its own — the legacy classifier's
    // tasks/:id switch defaults it to tasks.detail.
    entry("POST", ["tasks", ":id", "claim"], "tasks.detail", "other", dispatch, {
      ...workerBucket,
      drainRefused: true,
    }),
    entry("POST", ["tasks", ":id", "start"], "tasks.start", "other", dispatch, workerBucket),
    entry("POST", ["tasks", ":id", "heartbeat"], "tasks.heartbeat", "other", dispatch, workerBucket),
    entry("POST", ["tasks", ":id", "checkpoint"], "tasks.heartbeat", "other", dispatch, workerBucket),
    entry("POST", ["tasks", ":id", "complete"], "tasks.complete", "other", dispatch, workerBucket),
    entry("POST", ["tasks", ":id", "evidence"], "tasks.evidence", "other", dispatch, workerBucket),
    entry("POST", ["tasks", ":id", "fail"], "tasks.fail", "other", dispatch, workerBucket),
  ];
}

// ---------------------------------------------------------------------------
// 30. Audit read
// ---------------------------------------------------------------------------

export function createAuditReadRouteEntries(deps: RouteDeps<AuditReadRouteContext>): BrokerRouteEntry[] {
  return [
    entry("GET", ["audit"], "audit", "other", (rc) => handleAuditReadRouteIfMatched({ ...rc, ...deps })),
  ];
}

// ---------------------------------------------------------------------------
// 31. GitHub ingestion
// ---------------------------------------------------------------------------

export function createGitHubRouteEntries(deps: RouteDeps<GitHubRouteContext>): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleGitHubRouteIfMatched({ ...rc, ...deps });
  return [
    entry("POST", ["github", "webhook"], "other", "other", dispatch),
    entry("GET", ["github", "webhook", "health"], "other", "other", dispatch),
    entry("GET", ["github", "poller", "health"], "other", "other", dispatch),
  ];
}

