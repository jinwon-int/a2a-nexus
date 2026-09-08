/**
 * Decision/trading dialectic read-model and lifecycle routes (#2079 A).
 *
 * Previously four inline `req.method ===` blocks inside the server's handler
 * chain; extracted so the table-driven router can dispatch them like every
 * other route module. The legacy route classifier has no dialectic labels —
 * these paths classify as `tasks.detail` / `other`, and the entries keep that.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, type InMemoryA2ABroker } from "../core/broker.js";
import {
  assertRequesterHasRole,
  assertRequesterMatchesParty,
  type RequesterIdentity,
} from "../core/request-security.js";
import type { BrokerStateStore } from "../core/store.js";
import type { DecisionDialecticPatchV1, DecisionDialecticPhase } from "../decision-dialectic/types.js";
import {
  applyDecisionDialecticPatch,
  buildDecisionDialecticPhaseTaskRequest,
  DecisionDialecticExecutionError,
  extractDecisionDialecticTaskInput,
  nextDecisionDialecticPhase,
} from "../decision-dialectic/execution.js";
import {
  projectDecisionDialecticReadModel,
  DecisionDialecticReadModelError,
} from "../decision-dialectic/read-model.js";
import {
  projectTradingDialecticReadModel,
  TradingDialecticReadModelError,
} from "../trading-dialectic/read-model.js";
import { readJson } from "./body.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { sendJson } from "./response.js";
import type { BrokerRequestContext, BrokerRouteEntry } from "./route-table.js";

export interface DialecticRouteContext {
  method: string | undefined;
  segments: string[];
  req: IncomingMessage;
  res: ServerResponse;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

/** Route dispatcher for the dialectic routes. Returns true only when handled. */
export async function handleDialecticRoutesIfMatched(ctx: DialecticRouteContext): Promise<boolean> {
  if (ctx.segments[0] !== "tasks" || !ctx.segments[1]) {
    return false;
  }

  if (
    ctx.method === "GET" &&
    ctx.segments[2] === "decision-dialectic" &&
    ctx.segments.length === 3
  ) {
    const task = ctx.broker.getTask(ctx.segments[1]);
    if (!task) {
      throw new BrokerError("not_found", "task not found");
    }
    try {
      const readModel = projectDecisionDialecticReadModel(task);
      sendJson(ctx.res, 200, readModel);
      return true;
    } catch (error) {
      if (error instanceof DecisionDialecticReadModelError) {
        const code = error.code === "missing_contract" || error.code === "wrong_kind" ? "not_found" : "bad_request";
        throw new BrokerError(code, error.message);
      }
      throw error;
    }
  }

  if (
    ctx.method === "POST" &&
    ctx.segments[2] === "decision-dialectic" &&
    ctx.segments[3] === "advance" &&
    ctx.segments.length === 4
  ) {
    const body = (await readJson<{ id?: string; phase?: DecisionDialecticPhase }>(ctx.req)) ?? {};
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "decision-dialectic.advance");
    }
    const task = ctx.broker.getTask(ctx.segments[1]);
    if (!task) {
      throw new BrokerError("not_found", "task not found");
    }
    try {
      const { phase, request } = buildDecisionDialecticPhaseTaskRequest(task, {
        id: body.id,
        phase: body.phase,
        requesterId: ctx.requesterIdentity?.id,
      });
      const childTask = ctx.broker.createTask(request);
      await awaitDurablePersistenceAck(ctx.stateStore);
      sendJson(ctx.res, 201, {
        phase,
        parentTaskId: task.id,
        childTask,
      });
      return true;
    } catch (error) {
      if (error instanceof DecisionDialecticExecutionError) {
        const code =
          error.code === "missing_contract" || error.code === "wrong_kind"
            ? "not_found"
            : "bad_request";
        throw new BrokerError(code, error.message);
      }
      throw error;
    }
  }

  if (
    ctx.method === "POST" &&
    ctx.segments[2] === "decision-dialectic" &&
    ctx.segments[3] === "patch" &&
    ctx.segments.length === 4
  ) {
    const body = await readJson<DecisionDialecticPatchV1>(ctx.req);
    if (!body) {
      throw new BrokerError("bad_request", "request body is required");
    }
    if (ctx.enforceRequesterIdentity) {
      const requesterRole = ctx.requesterIdentity?.role;
      if (requesterRole === "hub" || requesterRole === "operator") {
        assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "decision-dialectic.patch");
      } else {
        assertRequesterMatchesParty(ctx.requesterIdentity, { id: body.authorAgent }, "decision-dialectic.patch");
      }
    }
    const task = ctx.broker.getTask(ctx.segments[1]);
    if (!task) {
      throw new BrokerError("not_found", "task not found");
    }
    try {
      const input = extractDecisionDialecticTaskInput(task.payload);
      const updatedTask = applyDecisionDialecticPatch(input.contract.task, body);
      const nextPhase = nextDecisionDialecticPhase(updatedTask) ?? input.contract.phase;
      const updated = ctx.broker.updateTaskPayload(
        task.id,
        {
          ...task.payload,
          contract: {
            ...input.contract,
            phase: nextPhase,
            task: updatedTask,
          },
        },
        {
          actor: {
            id: ctx.requesterIdentity?.id ?? body.authorAgent,
            kind: "node",
            role: ctx.requesterIdentity?.role,
          },
          note: "decision.dialectic patch " + body.op,
        },
      );
      await awaitDurablePersistenceAck(ctx.stateStore);
      const readModel = projectDecisionDialecticReadModel(updated);
      sendJson(ctx.res, 200, readModel);
      return true;
    } catch (error) {
      if (error instanceof DecisionDialecticExecutionError) {
        const code =
          error.code === "missing_contract" || error.code === "wrong_kind"
            ? "not_found"
            : error.code === "invalid_contract"
              ? "bad_request"
              : "invalid_transition";
        throw new BrokerError(code, error.message);
      }
      throw error;
    }
  }

  if (
    ctx.method === "GET" &&
    ctx.segments[2] === "trading-dialectic" &&
    ctx.segments.length === 3
  ) {
    const task = ctx.broker.getTask(ctx.segments[1]);
    if (!task) {
      throw new BrokerError("not_found", "task not found");
    }
    try {
      const readModel = projectTradingDialecticReadModel(task);
      sendJson(ctx.res, 200, readModel);
      return true;
    } catch (error) {
      if (error instanceof TradingDialecticReadModelError) {
        const code = error.code === "missing_contract" || error.code === "wrong_kind" ? "not_found" : "bad_request";
        throw new BrokerError(code, error.message);
      }
      throw error;
    }
  }

  return false;
}

export function createDialecticRouteEntries(
  deps: Omit<DialecticRouteContext, keyof BrokerRequestContext>,
): BrokerRouteEntry[] {
  const dispatch = (rc: BrokerRequestContext) => handleDialecticRoutesIfMatched({ ...rc, ...deps });
  return [
    entry("GET", ["tasks", ":id", "decision-dialectic"], dispatch),
    entry("POST", ["tasks", ":id", "decision-dialectic", "advance"], dispatch),
    entry("POST", ["tasks", ":id", "decision-dialectic", "patch"], dispatch),
    entry("GET", ["tasks", ":id", "trading-dialectic"], dispatch),
  ];
}

function entry(
  method: string,
  pattern: BrokerRouteEntry["pattern"],
  handle: (rc: BrokerRequestContext) => boolean | Promise<boolean>,
): BrokerRouteEntry {
  // The legacy classifier has no dialectic labels: these paths fall through
  // its tasks/:id switch to `tasks.detail` / `other`.
  return { method, pattern, route: "tasks.detail", group: "other", handle };
}
