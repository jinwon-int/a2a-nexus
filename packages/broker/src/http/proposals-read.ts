// Proposal read-path routes (GET /proposals, GET /proposals/:id), extracted from
// the server request closure into explicit-context handlers (#645 phase-3
// dispatcher migration; follows http/workers-read.ts). Each handler declares
// exactly the state it needs instead of capturing the whole server scope.

import type { ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { SqliteBrokerStateStore, type BrokerStateStore } from "../core/store.js";
import type { ChangeProposal, ProposalDetails, ProposalListFilters } from "../core/types.js";
import { sendJson } from "./response.js";
import { proposalFiltersFromUrl } from "./read-path-filters.js";

type ProposalSummary = Pick<
  ChangeProposal,
  "id" | "sourceNodeId" | "targetNodeId" | "kind" | "summary" | "status" | "updatedAt"
>;

function toProposalSummary(proposal: ChangeProposal): ProposalSummary {
  return {
    id: proposal.id,
    sourceNodeId: proposal.sourceNodeId,
    targetNodeId: proposal.targetNodeId,
    kind: proposal.kind,
    summary: proposal.summary,
    status: proposal.status,
    updatedAt: proposal.updatedAt,
  };
}

function listProposalSummariesForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  filters: ProposalListFilters,
): ProposalSummary[] {
  const proposals = stateStore instanceof SqliteBrokerStateStore
    ? stateStore.readHotProposals(filters)
    : broker.listProposals(filters);
  return proposals.map(toProposalSummary);
}

function getProposalDetailsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  proposalId: string,
): ProposalDetails | null {
  if (!(stateStore instanceof SqliteBrokerStateStore)) {
    return broker.getProposalDetails(proposalId);
  }

  const proposal = stateStore.readHotProposals({ id: proposalId })[0];
  if (!proposal) {
    return null;
  }

  return {
    proposal,
    artifacts: broker.listArtifactsForProposal(proposalId),
    validations: broker.listValidationsForProposal(proposalId),
    audit: stateStore.readHotAuditEvents({ proposalId }),
  };
}

export interface ProposalsReadContext {
  res: ServerResponse;
  url: URL;
  stateStore: BrokerStateStore;
  broker: InMemoryA2ABroker;
}

/** GET /proposals — list proposal summaries honoring status/source/target/kind filters. */
export function handleProposalsListRequest(ctx: ProposalsReadContext): void {
  const filters = proposalFiltersFromUrl(ctx.url);
  sendJson(ctx.res, 200, { items: listProposalSummariesForReadPath(ctx.stateStore, ctx.broker, filters) });
}

/** GET /proposals/:id — full proposal details; 404 when unknown. */
export function handleProposalByIdRequest(ctx: ProposalsReadContext & { proposalId: string }): void {
  const details = getProposalDetailsForReadPath(ctx.stateStore, ctx.broker, ctx.proposalId);
  if (!details) {
    throw new BrokerError("not_found", "proposal not found");
  }
  sendJson(ctx.res, 200, details);
}
