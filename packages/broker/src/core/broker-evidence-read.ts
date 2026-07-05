import { sortedCopy, sortNewestFirst } from "./broker-helpers.js";
import type { ArtifactRuntimeRepository } from "./artifact-repository.js";
import type { AuditRuntimeRepository } from "./audit-repository.js";
import type { ValidationRuntimeRepository } from "./validation-repository.js";
import type {
  ArtifactRecord,
  AuditEvent,
  AuditListFilters,
  ValidationResult,
} from "./types.js";

export function readBrokerArtifact(
  artifacts: Map<string, ArtifactRecord>,
  artifactRepository: ArtifactRuntimeRepository | undefined,
  id: string,
): ArtifactRecord | null {
  const repositoryArtifact = artifactRepository?.getArtifact(id);
  if (repositoryArtifact) {
    artifacts.set(repositoryArtifact.id, repositoryArtifact);
    return repositoryArtifact;
  }
  return artifacts.get(id) ?? null;
}

export function listBrokerArtifactsForProposal(
  artifacts: Map<string, ArtifactRecord>,
  artifactRepository: ArtifactRuntimeRepository | undefined,
  proposalId: string,
): ArtifactRecord[] {
  const repositoryArtifacts = artifactRepository?.listArtifactsForProposal(proposalId);
  if (repositoryArtifacts) {
    for (const artifact of repositoryArtifacts) {
      artifacts.set(artifact.id, artifact);
    }
    return sortedCopy(repositoryArtifacts, sortNewestFirst);
  }
  return sortedCopy(
    [...artifacts.values()].filter((artifact) => artifact.proposalId === proposalId),
    sortNewestFirst,
  );
}

export function listBrokerValidationsForProposal(
  validations: Map<string, ValidationResult>,
  validationRepository: ValidationRuntimeRepository | undefined,
  proposalId: string,
): ValidationResult[] {
  const repositoryValidations = validationRepository?.listValidationsForProposal(proposalId);
  if (repositoryValidations) {
    for (const validation of repositoryValidations) {
      validations.set(validation.id, validation);
    }
    return sortedCopy(repositoryValidations, sortNewestFirst);
  }
  return sortedCopy(
    [...validations.values()].filter((validation) => validation.proposalId === proposalId),
    sortNewestFirst,
  );
}

export function listBrokerAuditEvents(
  auditEvents: Map<string, AuditEvent>,
  auditRepository: AuditRuntimeRepository | undefined,
  filters?: AuditListFilters,
): AuditEvent[] {
  const eventsById = new Map(auditEvents);
  if (auditRepository) {
    const events = auditRepository.listAuditEvents(filters);
    for (const event of events) {
      auditEvents.set(event.id, event);
      eventsById.set(event.id, event);
    }
  }
  return sortedCopy(
    [...eventsById.values()].filter((event) => {
      if (filters?.proposalId && event.proposalId !== filters.proposalId) {
        return false;
      }
      if (filters?.actorId && event.actorId !== filters.actorId) {
        return false;
      }
      if (filters?.action && event.action !== filters.action) {
        return false;
      }
      if (filters?.targetId && event.targetId !== filters.targetId) {
        return false;
      }
      return true;
    }),
    sortNewestFirst,
  );
}
