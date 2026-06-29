// Proposal write routes (POST /proposals and the POST
// /proposals/:id/{artifacts,validate,approve,reject,apply} mutations), extracted
// from the server request closure into explicit-context handlers (continuing the
// #645 dispatcher migration; the GET read paths already live in proposals-read.ts).
// Each handler reads and validates its body, enforces the requester-party check,
// invokes the broker, awaits the durable-persistence ack, and replies — taking
// exactly what it needs via the route context with no closure capture.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import {
  assertRequesterCanTouchProposalArtifacts,
  assertRequesterMatchesParty,
  type RequesterIdentity,
} from "../core/request-security.js";
import type {
  ApplyProposalRequest,
  AttachArtifactRequest,
  ChangeProposal,
  CreateProposalRequest,
  ProposalActorRequest,
  SubmitValidationRequest,
} from "../core/types.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

export interface ProposalsWriteRouteContext {
  method: string | undefined;
  path: string;
  segments: string[];
  req: IncomingMessage;
  res: ServerResponse;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

type ProposalScopedContext = ProposalsWriteRouteContext & { proposalId: string };

function sendProposalDecision(ctx: ProposalScopedContext, proposal: ChangeProposal): void {
  sendJson(ctx.res, 200, {
    ok: true,
    proposalId: proposal.id,
    status: proposal.status,
    updatedAt: proposal.updatedAt,
  });
}

/** POST /proposals — create a change proposal. */
export async function handleCreateProposalRequest(ctx: ProposalsWriteRouteContext): Promise<void> {
  const body = await readJson<CreateProposalRequest>(ctx.req);
  if (!body) {
    throw new BrokerError("bad_request", "request body is required");
  }
  if (ctx.enforceRequesterIdentity) {
    assertRequesterMatchesParty(
      ctx.requesterIdentity,
      { id: body.source.id, role: body.source.role },
      "proposal.create",
    );
  }
  const proposal = ctx.broker.createProposal(body);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 201, proposal);
}

/** POST /proposals/:id/artifacts — attach an artifact to a proposal. */
export async function handleAttachArtifactRequest(ctx: ProposalScopedContext): Promise<void> {
  const body = await readJson<AttachArtifactRequest>(ctx.req);
  if (!body) {
    throw new BrokerError("bad_request", "request body is required");
  }
  if (ctx.enforceRequesterIdentity) {
    const proposal = ctx.broker.getProposal(ctx.proposalId);
    if (!proposal) {
      throw new BrokerError("not_found", "proposal not found");
    }
    assertRequesterCanTouchProposalArtifacts(ctx.requesterIdentity, proposal);
  }
  const artifact = ctx.broker.attachArtifact(ctx.proposalId, body);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 201, artifact);
}

/** POST /proposals/:id/validate — submit a validation result. */
export async function handleSubmitValidationRequest(ctx: ProposalScopedContext): Promise<void> {
  const body = await readJson<SubmitValidationRequest>(ctx.req);
  if (!body) {
    throw new BrokerError("bad_request", "request body is required");
  }
  if (ctx.enforceRequesterIdentity) {
    assertRequesterMatchesParty(ctx.requesterIdentity, { id: body.nodeId }, "proposal.validate");
  }
  const validation = ctx.broker.submitValidationResult(ctx.proposalId, body);
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 201, validation);
}

/** Shared body+identity handling for the actor-gated approve/reject decisions. */
async function handleActorDecision(
  ctx: ProposalScopedContext,
  scope: string,
  decide: (proposalId: string, body: ProposalActorRequest) => ChangeProposal,
): Promise<void> {
  const body = await readJson<ProposalActorRequest>(ctx.req);
  if (!body?.actor?.id) {
    throw new BrokerError("bad_request", "actor.id is required");
  }
  if (ctx.enforceRequesterIdentity) {
    assertRequesterMatchesParty(
      ctx.requesterIdentity,
      { id: body.actor.id, role: body.actor.role },
      scope,
    );
  }
  sendProposalDecision(ctx, decide(ctx.proposalId, body));
}

/** POST /proposals/:id/apply — apply the proposal locally. */
export async function handleApplyProposalRequest(ctx: ProposalScopedContext): Promise<void> {
  const body = await readJson<ApplyProposalRequest>(ctx.req);
  if (!body?.actor?.id || !body.workspace?.nodeId || !body.workspace?.workspaceId) {
    throw new BrokerError("bad_request", "actor.id, workspace.nodeId, and workspace.workspaceId are required");
  }
  if (ctx.enforceRequesterIdentity) {
    assertRequesterMatchesParty(
      ctx.requesterIdentity,
      { id: body.actor.id, role: body.actor.role },
      "proposal.apply",
    );
  }
  sendProposalDecision(ctx, ctx.broker.applyProposalLocally(ctx.proposalId, body));
}

/** Route dispatcher for proposal write routes. Returns true only when handled. */
export async function handleProposalsWriteRouteIfMatched(
  ctx: ProposalsWriteRouteContext,
): Promise<boolean> {
  if (ctx.method !== "POST") {
    return false;
  }
  if (ctx.path === "/proposals") {
    await handleCreateProposalRequest(ctx);
    return true;
  }
  if (!(ctx.segments[0] === "proposals" && ctx.segments[1])) {
    return false;
  }
  const scoped: ProposalScopedContext = { ...ctx, proposalId: ctx.segments[1] };
  switch (ctx.segments[2]) {
    case "artifacts":
      await handleAttachArtifactRequest(scoped);
      return true;
    case "validate":
      await handleSubmitValidationRequest(scoped);
      return true;
    case "approve":
      await handleActorDecision(scoped, "proposal.approve", (id, body) => ctx.broker.approveProposal(id, body));
      return true;
    case "reject":
      await handleActorDecision(scoped, "proposal.reject", (id, body) => ctx.broker.rejectProposal(id, body));
      return true;
    case "apply":
      await handleApplyProposalRequest(scoped);
      return true;
    default:
      return false;
  }
}
