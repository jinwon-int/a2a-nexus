import type { A2AExchangeIntent, WorkerView } from "./types.js";
import {
  createDefaultCapabilityCard,
  queryWorkerCapabilityCards,
  type WorkerAssignmentRole,
  type WorkerCapabilityCard,
  type WorkerCapabilityCardQuery,
  type WorkerCapabilityCardRepository,
} from "./worker-capability-card.js";

export type BrokerDefaultCapabilityProfileOptions = {
  teamId?: "team1" | "team2";
  brokerOfRecord?: string;
  lane?: "team1" | "team2";
  assignmentRoles?: WorkerAssignmentRole[];
  supportedTaskTypes?: A2AExchangeIntent[];
};

export function storeBrokerCapabilityProfile(
  capabilityCards: WorkerCapabilityCardRepository,
  card: WorkerCapabilityCard,
): void {
  capabilityCards.store(card);
}

export function readBrokerCapabilityProfile(
  capabilityCards: WorkerCapabilityCardRepository,
  workerId: string,
): WorkerCapabilityCard | null {
  return capabilityCards.get(workerId);
}

export function listBrokerCapabilityProfiles(
  capabilityCards: WorkerCapabilityCardRepository,
  query?: WorkerCapabilityCardQuery,
): WorkerCapabilityCard[] {
  const cards = capabilityCards.list();
  if (!query || Object.keys(query).length === 0) {
    return cards;
  }
  return queryWorkerCapabilityCards(cards, query);
}

export function deleteBrokerCapabilityProfile(
  capabilityCards: WorkerCapabilityCardRepository,
  workerId: string,
): void {
  capabilityCards.delete(workerId);
}

export function registerDefaultBrokerCapabilityProfile(
  capabilityCards: WorkerCapabilityCardRepository,
  worker: WorkerView,
  defaults?: BrokerDefaultCapabilityProfileOptions,
): WorkerCapabilityCard {
  const card = createDefaultCapabilityCard(worker, defaults);
  capabilityCards.store(card);
  return card;
}
