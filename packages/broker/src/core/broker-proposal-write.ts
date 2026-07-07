// Proposal write paths extracted from broker.ts (#1289 R4 L-broker-11).
// The six RBAC-gated proposal lifecycle writes — create, artifact attach,
// validation submit, approve, reject, apply — plus normalizePolicyError,
// whose only consumers are these methods. Pure move: every state transition
// keeps its exact assertTransition allow-list, RBAC check, audit action
// string, and persist point; state effects are callback-injected via
// ProposalWriteContext (the broker-exchange.ts pattern) so write ordering and
// audit emission are byte-identical. InMemoryA2ABroker keeps public
// delegators. Proposal READ paths live in broker-proposal-read paths already.
import { randomUUID } from "node:crypto";

import { BrokerError } from "./broker-error.js";
import { isoNow, uniqueIds } from "./broker-helpers.js";
import { assertProposalPayload } from "./broker-payload-validators.js";
import { assertTransition } from "./broker-transition-guards.js";
import {
  assertProposalApplyAllowed,
  assertProposalCreationAllowed,
  assertProposalReviewAllowed,
  assertValidationSubmissionAllowed,
  PolicyError,
} from "./policy.js";
import type {
  ApplyProposalRequest,
  ArtifactRecord,
  AttachArtifactRequest,
  AuditAction,
  AuditEvent,
  ChangeProposal,
  CreateProposalRequest,
  ProposalActorRequest,
  SubmitValidationRequest,
  ValidationResult,
} from "./types.js";

export interface ProposalWriteContext {
  requireProposal(id: string): ChangeProposal;
  setProposalRecord(proposal: ChangeProposal): void;
  setArtifactRecord(artifact: ArtifactRecord): void;
  setValidationRecord(validation: ValidationResult): void;
  appendAuditEvent(input: {
    actorId: string;
    action: AuditAction;
    targetType: AuditEvent["targetType"];
    targetId: string;
    proposalId?: string;
    note?: string;
  }): AuditEvent;
  persistState(): void;
}

export function normalizePolicyError(error: unknown): BrokerError {
  if (error instanceof BrokerError) {
    return error;
  }

  if (error instanceof PolicyError) {
    return new BrokerError(error.code, error.message);
  }

  return new BrokerError("policy_denied", "policy denied");
}

export function createProposal(request: CreateProposalRequest, context: ProposalWriteContext): ChangeProposal {
  assertProposalPayload(request);

  try {
    assertProposalCreationAllowed(request.source, request.target);
  } catch (error) {
    throw normalizePolicyError(error);
  }

  const now = isoNow();
  const proposal: ChangeProposal = {
    id: randomUUID(),
    source: request.source,
    target: request.target,
    sourceNodeId: request.source.id,
    targetNodeId: request.target.id,
    kind: request.kind,
    summary: request.summary,
    rationale: request.rationale,
    workspace: request.workspace,
    patchText: request.patchText,
    parameterPayload: request.parameterPayload,
    artifactIds: [...(request.artifactIds ?? [])],
    status: "submitted",
    createdAt: now,
    updatedAt: now,
  };

  context.setProposalRecord(proposal);
  context.appendAuditEvent({
    actorId: request.source.id,
    action: "proposal.created",
    targetType: "proposal",
    targetId: proposal.id,
    proposalId: proposal.id,
    note: request.summary,
  });
  context.persistState();
  return proposal;
}

export function attachArtifact(
  proposalId: string,
  request: AttachArtifactRequest,
  context: ProposalWriteContext,
): ArtifactRecord {
  const proposal = context.requireProposal(proposalId);
  if (!request.kind || !request.uri) {
    throw new BrokerError("bad_request", "kind and uri are required");
  }

  const artifact: ArtifactRecord = {
    id: randomUUID(),
    proposalId,
    kind: request.kind,
    uri: request.uri,
    contentType: request.contentType,
    sizeBytes: request.sizeBytes,
    summary: request.summary,
    createdAt: isoNow(),
  };

  context.setArtifactRecord(artifact);
  proposal.artifactIds = uniqueIds([...proposal.artifactIds, artifact.id]);
  proposal.updatedAt = isoNow();
  context.setProposalRecord(proposal);

  context.appendAuditEvent({
    actorId: proposal.sourceNodeId,
    action: "artifact.attached",
    targetType: "artifact",
    targetId: artifact.id,
    proposalId,
    note: artifact.summary,
  });

  context.persistState();
  return artifact;
}

export function submitValidationResult(
  proposalId: string,
  request: SubmitValidationRequest,
  context: ProposalWriteContext,
): ValidationResult {
  const proposal = context.requireProposal(proposalId);
  if (!request.kind || !request.verdict || !request.nodeId) {
    throw new BrokerError("bad_request", "nodeId, kind, and verdict are required");
  }

  try {
    assertValidationSubmissionAllowed(proposal, request);
  } catch (error) {
    throw normalizePolicyError(error);
  }

  const validation: ValidationResult = {
    id: randomUUID(),
    proposalId,
    nodeId: request.nodeId,
    kind: request.kind,
    verdict: request.verdict,
    metrics: request.metrics ?? {},
    artifactIds: [...(request.artifactIds ?? [])],
    note: request.note,
    createdAt: isoNow(),
  };

  context.setValidationRecord(validation);
  // Only advance to "validated" from a pre-decision state. A stale validation
  // — e.g. a validate_change task that completes after the proposal was
  // already approved/applied/rejected — must not rewind the proposal into a
  // second approve/apply cycle. The validation is still recorded as evidence.
  if (proposal.status === "submitted" || proposal.status === "validated") {
    proposal.status = "validated";
  }
  proposal.updatedAt = isoNow();
  proposal.artifactIds = uniqueIds([...proposal.artifactIds, ...validation.artifactIds]);
  context.setProposalRecord(proposal);

  context.appendAuditEvent({
    actorId: request.nodeId,
    action: "validation.submitted",
    targetType: "validation",
    targetId: validation.id,
    proposalId,
    note: request.note,
  });

  context.persistState();
  return validation;
}

export function approveProposal(
  proposalId: string,
  request: ProposalActorRequest,
  context: ProposalWriteContext,
): ChangeProposal {
  const proposal = context.requireProposal(proposalId);
  assertTransition(proposal.status, ["submitted", "validated"], "approve");

  try {
    assertProposalReviewAllowed(proposal, request);
  } catch (error) {
    throw normalizePolicyError(error);
  }

  proposal.status = "approved";
  proposal.updatedAt = isoNow();
  context.setProposalRecord(proposal);
  context.appendAuditEvent({
    actorId: request.actor.id,
    action: "proposal.approved",
    targetType: "proposal",
    targetId: proposal.id,
    proposalId,
    note: request.note,
  });
  context.persistState();
  return proposal;
}

export function rejectProposal(
  proposalId: string,
  request: ProposalActorRequest,
  context: ProposalWriteContext,
): ChangeProposal {
  const proposal = context.requireProposal(proposalId);
  assertTransition(proposal.status, ["submitted", "validated"], "reject");

  try {
    assertProposalReviewAllowed(proposal, request);
  } catch (error) {
    throw normalizePolicyError(error);
  }

  proposal.status = "rejected";
  proposal.updatedAt = isoNow();
  context.setProposalRecord(proposal);
  context.appendAuditEvent({
    actorId: request.actor.id,
    action: "proposal.rejected",
    targetType: "proposal",
    targetId: proposal.id,
    proposalId,
    note: request.note,
  });
  context.persistState();
  return proposal;
}

export function applyProposalLocally(
  proposalId: string,
  request: ApplyProposalRequest,
  context: ProposalWriteContext,
): ChangeProposal {
  const proposal = context.requireProposal(proposalId);
  assertTransition(proposal.status, ["approved"], "apply");

  if (request.workspace.nodeId !== proposal.targetNodeId) {
    throw new BrokerError(
      "policy_denied",
      "apply workspace nodeId must match the proposal target node",
    );
  }

  try {
    assertProposalApplyAllowed(proposal, request);
  } catch (error) {
    throw normalizePolicyError(error);
  }

  proposal.status = "applied";
  proposal.updatedAt = isoNow();
  context.setProposalRecord(proposal);
  context.appendAuditEvent({
    actorId: request.actor.id,
    action: "proposal.applied",
    targetType: "proposal",
    targetId: proposal.id,
    proposalId,
    note: request.note,
  });
  context.persistState();
  return proposal;
}
