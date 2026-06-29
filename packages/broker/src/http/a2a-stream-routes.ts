// A2A SSE stream routes (GET /a2a/tasks/terminal-events, GET
// /a2a/operator/events), extracted from the server request closure into
// explicit-context handlers (continuing the #645 dispatcher migration). Both
// hold the connection open and delegate to a dedicated SSE stream handler; the
// operator-event stream needs the server's snapshot/replay/subscribe closures,
// so those ride in the route context rather than being closure-captured.
import type { IncomingMessage, ServerResponse } from "node:http";

import { InMemoryA2ABroker } from "../core/broker.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import type {
  BufferedOperatorEvent,
  OperatorReplayWindow,
  OperatorSnapshotEvent,
} from "../server.js";
import { handleTerminalTaskEventStream } from "./task-event-streams.js";
import { handleOperatorEventStream } from "./operator-events.js";

export interface A2AStreamRouteContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  broker: InMemoryA2ABroker;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
  taskSubscribeHeartbeatSec: number;
  currentOperatorSnapshot: () => OperatorSnapshotEvent;
  replayOperatorEvents: (afterSeq: number) => BufferedOperatorEvent[];
  subscribeToOperatorEvents: (listener: (event: BufferedOperatorEvent) => void) => () => void;
  currentOperatorReplayWindow: () => OperatorReplayWindow;
}

/** GET /a2a/tasks/terminal-events — SSE stream of terminal task events. */
export function handleTerminalTaskEventsStreamRoute(ctx: A2AStreamRouteContext): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "task-terminal.subscribe");
  }
  handleTerminalTaskEventStream(ctx.req, ctx.res, {
    broker: ctx.broker,
    heartbeatMs: ctx.taskSubscribeHeartbeatSec * 1000,
  });
}

/** GET /a2a/operator/events — SSE stream of operator snapshot/diff events. */
export function handleOperatorEventsStreamRoute(ctx: A2AStreamRouteContext): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "operator.subscribe");
  }
  handleOperatorEventStream(ctx.req, ctx.res, {
    currentSnapshot: ctx.currentOperatorSnapshot,
    replayEvents: ctx.replayOperatorEvents,
    subscribe: ctx.subscribeToOperatorEvents,
    replayWindow: ctx.currentOperatorReplayWindow,
    heartbeatMs: ctx.taskSubscribeHeartbeatSec * 1000,
  });
}

/** Route dispatcher for the A2A SSE stream routes. Returns true only when handled. */
export function handleA2AStreamRouteIfMatched(ctx: A2AStreamRouteContext): boolean {
  if (ctx.method !== "GET") {
    return false;
  }
  if (ctx.path === "/a2a/tasks/terminal-events") {
    handleTerminalTaskEventsStreamRoute(ctx);
    return true;
  }
  if (ctx.path === "/a2a/operator/events") {
    handleOperatorEventsStreamRoute(ctx);
    return true;
  }
  return false;
}
