// Operator reporting read routes (GET /terminal-brief/inbox, GET
// /release/evidence, GET /operator/task-report), extracted from the server
// request closure into explicit-context handlers (continuing the #645 dispatcher
// migration). All are read-only operator reports gated on the hub/operator role.
import type { ServerResponse } from "node:http";

import { InMemoryA2ABroker } from "../core/broker.js";
import { SqliteBrokerStateStore, type BrokerStateStore } from "../core/store.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import type { TaskRecord } from "../core/types.js";
import { queryTerminalBriefInbox } from "../core/terminal-brief-query-api.js";
import { buildReleaseEvidenceExport } from "../core/release-evidence.js";
import { buildOperatorTaskReport } from "../core/operator-task-report.js";
import { getTaskForReadPath, listTasksForReadPath, mapBrokerDiagnosticsToSnapshot } from "../task-read-paths.js";
import { optionalString } from "../request-parsers.js";
import { booleanQueryParam } from "./request-params.js";
import { numberQueryParam, taskFiltersFromUrl, taskIdsFromUrl } from "./read-path-filters.js";
import { sendJson } from "./response.js";

export interface OperatorReportingReadRouteContext {
  method: string | undefined;
  path: string;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

/** GET /terminal-brief/inbox — filtered terminal-brief outbox inbox view. */
export function handleTerminalBriefInboxRequest(ctx: OperatorReportingReadRouteContext): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "terminal_brief.inbox.read");
  }

  const outbox = ctx.broker.getTerminalTaskEventOutbox();
  const includeAll = booleanQueryParam(ctx.url, "all") ?? false;
  const filter = {
    parentRoundId: optionalString(ctx.url.searchParams.get("parent_round_id") ?? ctx.url.searchParams.get("parentRoundId")),
    originBrokerId: optionalString(ctx.url.searchParams.get("origin_broker_id") ?? ctx.url.searchParams.get("originBrokerId")),
    brokerOfRecordId: optionalString(ctx.url.searchParams.get("broker_of_record_id") ?? ctx.url.searchParams.get("brokerOfRecordId")),
    worker: optionalString(ctx.url.searchParams.get("worker")),
    taskStatus: optionalString(ctx.url.searchParams.get("task_status") ?? ctx.url.searchParams.get("taskStatus")),
    ticketRef: optionalString(ctx.url.searchParams.get("ticket_ref") ?? ctx.url.searchParams.get("ticketRef")),
    ...(includeAll ? {} : { unacked: true }),
  };
  const inbox = queryTerminalBriefInbox(
    outbox,
    filter,
    { afterId: optionalString(ctx.url.searchParams.get("after_id") ?? ctx.url.searchParams.get("afterId")) },
    numberQueryParam(ctx.url, "limit"),
  );
  sendJson(ctx.res, 200, {
    kind: "a2a-broker.terminal-brief.inbox",
    summary: inbox.summary,
    query: inbox.query,
  }, {
    "cache-control": "no-store",
  });
}

/** GET /release/evidence — release evidence export for the selected tasks. */
export function handleReleaseEvidenceRequest(ctx: OperatorReportingReadRouteContext): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "release.evidence.read");
  }
  const filters = taskFiltersFromUrl(ctx.url);
  const wantedTaskIds = new Set(taskIdsFromUrl(ctx.url));
  const tasks = listTasksForReadPath(ctx.stateStore, ctx.broker, filters)
    .filter((task) => wantedTaskIds.size === 0 || wantedTaskIds.has(task.id));
  const report = buildReleaseEvidenceExport(tasks, {
    repo: optionalString(ctx.url.searchParams.get("repo")),
    issue: optionalString(ctx.url.searchParams.get("issue")),
    parentIssue: optionalString(ctx.url.searchParams.get("parentIssue") ?? ctx.url.searchParams.get("parent_issue")),
    runId: optionalString(ctx.url.searchParams.get("runId") ?? ctx.url.searchParams.get("run_id")),
    ...(ctx.stateStore instanceof SqliteBrokerStateStore
      ? {
          terminalOutboxDiagnostics: mapBrokerDiagnosticsToSnapshot(
            ctx.stateStore.readHotTerminalOutboxDiagnostics(),
          ),
        }
      : {}),
  });
  sendJson(ctx.res, 200, report, {
    "cache-control": "no-store",
  });
}

/** GET /operator/task-report — operator task report over selected (or all) tasks. */
export function handleOperatorTaskReportRequest(ctx: OperatorReportingReadRouteContext): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "operator.task-report");
  }
  const taskIds = taskIdsFromUrl(ctx.url);
  const parentIssue = optionalString(ctx.url.searchParams.get("parent_issue"));
  const staleAfterMs = numberQueryParam(ctx.url, "stale_after_ms") ?? 15 * 60 * 1000;
  const updatedAfter = optionalString(ctx.url.searchParams.get("updated_after"));
  const tasks = taskIds.length
    ? taskIds.map((id) => getTaskForReadPath(ctx.stateStore, ctx.broker, id)).filter((task): task is TaskRecord => Boolean(task))
    : listTasksForReadPath(ctx.stateStore, ctx.broker, {});
  const terminalOutbox = ctx.broker.getTerminalTaskEventOutbox().subscribe();
  sendJson(ctx.res, 200, buildOperatorTaskReport(tasks, { taskIds, parentIssue, staleAfterMs, updatedAfter, terminalOutbox }));
}

/** Route dispatcher for operator reporting read routes. Returns true only when handled. */
export function handleOperatorReportingReadRouteIfMatched(
  ctx: OperatorReportingReadRouteContext,
): boolean {
  if (ctx.method !== "GET") {
    return false;
  }
  if (ctx.path === "/terminal-brief/inbox") {
    handleTerminalBriefInboxRequest(ctx);
    return true;
  }
  if (ctx.path === "/release/evidence") {
    handleReleaseEvidenceRequest(ctx);
    return true;
  }
  if (ctx.path === "/operator/task-report") {
    handleOperatorTaskReportRequest(ctx);
    return true;
  }
  return false;
}
