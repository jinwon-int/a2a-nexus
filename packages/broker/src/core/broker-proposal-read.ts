import { proposalMatchesFilters } from "./broker-list-filters.js";
import { sortedCopy, sortNewestFirst } from "./broker-helpers.js";
import type { ProposalRuntimeRepository } from "./proposal-repository.js";
import type { ChangeProposal, ProposalListFilters } from "./types.js";

export function readBrokerProposal(
  proposals: Map<string, ChangeProposal>,
  proposalRepository: ProposalRuntimeRepository | undefined,
  id: string,
): ChangeProposal | null {
  const repositoryProposal = proposalRepository?.getProposal(id);
  if (repositoryProposal) {
    proposals.set(repositoryProposal.id, repositoryProposal);
    return repositoryProposal;
  }
  return proposals.get(id) ?? null;
}

export function listBrokerProposals(
  proposals: Map<string, ChangeProposal>,
  proposalRepository: ProposalRuntimeRepository | undefined,
  filters?: ProposalListFilters,
): ChangeProposal[] {
  if (proposalRepository) {
    const repositoryProposals = proposalRepository.listProposals(filters);
    for (const repositoryProposal of repositoryProposals) {
      proposals.set(repositoryProposal.id, repositoryProposal);
    }
    return sortedCopy(
      repositoryProposals.filter((proposal) => proposalMatchesFilters(proposal, filters)),
      sortNewestFirst,
    );
  }
  return sortedCopy(
    [...proposals.values()].filter((proposal) => proposalMatchesFilters(proposal, filters)),
    sortNewestFirst,
  );
}
