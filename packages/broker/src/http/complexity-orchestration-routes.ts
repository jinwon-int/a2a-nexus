import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError } from "../core/broker.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import type { A2AExchangeIntent } from "../core/types.js";
import {
  buildA2AWorkerSubagentOrchestrationPolicy,
  extractA2AWorkerSubagentPolicyInput,
} from "../core/worker-subagent-orchestration-policy.js";
import {
  classifyTaskComplexity,
  type TaskComplexityInput as ComplexityOrchestrationTaskComplexityInput,
} from "../core/task-complexity-classifier.js";
import {
  buildComplexityOrchestrationRecommendation,
  type ComplexityOrchestrationRecommendationPacket,
} from "../core/complexity-orchestration-recommendation.js";
import {
  buildFinalizerApprovalEnvelopeDraft,
  type FinalizerApprovalEnvelopeDraftPacket,
} from "../core/complexity-finalizer-approval-envelope-draft.js";
import {
  buildComplexityExecutionPlanDraft,
  extractEnvelopeFromExecutionPlan,
} from "../core/complexity-execution-plan-draft.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

const COMPLEXITY_ORCHESTRATION_ROLES = ["hub", "operator", "analyst", "researcher", "live-trader"] as const;

export interface ComplexityOrchestrationRoutesContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

/**
 * Stateless source-only complexity/orchestration POST routes extracted from server.ts (#848).
 * Returns true only when one of the route paths is handled.
 */
export async function handleComplexityOrchestrationRoutesIfMatched(
  ctx: ComplexityOrchestrationRoutesContext,
): Promise<boolean> {
  if (ctx.method === "POST" && ctx.path === "/workers/subagent-orchestration/plan") {
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, [...COMPLEXITY_ORCHESTRATION_ROLES], "worker_subagent_orchestration.plan");
    }
    const body = await readJson<Record<string, unknown>>(ctx.req);
    let input;
    try {
      input = extractA2AWorkerSubagentPolicyInput(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid worker subagent orchestration policy input";
      throw new BrokerError("bad_request", message);
    }
    const packet = buildA2AWorkerSubagentOrchestrationPolicy(input);
    sendJson(ctx.res, 200, packet, {
      "cache-control": "no-store",
    });
    return true;
  }

  if (ctx.method === "POST" && ctx.path === "/complexity-orchestration/recommendation") {
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, [...COMPLEXITY_ORCHESTRATION_ROLES], "complexity_orchestration.recommendation");
    }
    const body = await readJson<Record<string, unknown>>(ctx.req);
    let input: ComplexityOrchestrationTaskComplexityInput;
    try {
      const rawIntent = body?.intent;
      if (typeof rawIntent !== "string" || rawIntent.length === 0) {
        throw new TypeError("missing or invalid 'intent' field");
      }
      const intent = rawIntent as A2AExchangeIntent;
      input = {
        intent,
        targetEnvironment: body?.targetEnvironment as ComplexityOrchestrationTaskComplexityInput["targetEnvironment"],
        policyContext: body?.policyContext as ComplexityOrchestrationTaskComplexityInput["policyContext"],
        referenceCount: typeof body?.referenceCount === "number" ? body?.referenceCount : undefined,
        artifactCount: typeof body?.artifactCount === "number" ? body?.artifactCount : undefined,
        turnCount: typeof body?.turnCount === "number" ? body?.turnCount : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid complexity orchestration recommendation input";
      throw new BrokerError("bad_request", message);
    }
    const classification = classifyTaskComplexity(input);
    const packet = buildComplexityOrchestrationRecommendation(classification);
    sendJson(ctx.res, 200, packet, {
      "cache-control": "no-store",
    });
    return true;
  }

  if (ctx.method === "POST" && ctx.path === "/complexity-execution-plan/draft") {
    if (ctx.enforceRequesterIdentity) {
      assertRequesterHasRole(ctx.requesterIdentity, [...COMPLEXITY_ORCHESTRATION_ROLES], "complexity_execution_plan.draft");
    }
    const body = await readJson<Record<string, unknown>>(ctx.req);
    let envelope: FinalizerApprovalEnvelopeDraftPacket;
    try {
      if (body?.kind === "a2a-broker.complexity-orchestration-recommendation-packet") {
        envelope = buildFinalizerApprovalEnvelopeDraft(body as unknown as ComplexityOrchestrationRecommendationPacket);
      } else {
        envelope = extractEnvelopeFromExecutionPlan(body);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid complexity execution plan draft input";
      throw new BrokerError("bad_request", message);
    }
    const packet = buildComplexityExecutionPlanDraft(envelope);
    sendJson(ctx.res, 200, packet, {
      "cache-control": "no-store",
    });
    return true;
  }

  return false;
}
