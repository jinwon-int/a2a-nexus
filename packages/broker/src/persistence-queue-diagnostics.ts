// Persistence-queue diagnostics helpers extracted from server.ts: the disabled
// and unavailable placeholder diagnostics, the provider read wrapper, and the
// normalizer. Pure functions over a diagnostics provider passed in. The two
// diagnostics types remain exported from server.ts (other modules import them
// from there) and are imported here type-only, so there is no runtime cycle.
import { truncateMessage } from "./http/response.js";
import type {
  BrokerPersistenceQueueDiagnostics,
  BrokerPersistenceQueueDiagnosticsProvider,
} from "./server.js";

export function disabledPersistenceQueueDiagnostics(): BrokerPersistenceQueueDiagnostics {
  return {
    kind: "broker.persistence.queue",
    enabled: false,
    mode: "inline",
    state: "disabled",
    capacity: null,
    queued: 0,
    active: 0,
    inFlight: 0,
    available: null,
    closing: false,
    aborted: false,
  };
}

export function unavailablePersistenceQueueDiagnostics(error: unknown): BrokerPersistenceQueueDiagnostics {
  return {
    kind: "broker.persistence.queue",
    enabled: true,
    mode: "worker_thread",
    state: "unavailable",
    capacity: null,
    queued: 0,
    active: 0,
    inFlight: 0,
    available: null,
    closing: false,
    aborted: false,
    lastErrorCode: "worker_unavailable",
    lastErrorAt: new Date().toISOString(),
    lastErrorMessage: truncateMessage(error instanceof Error ? error.message : String(error), 200),
  };
}

export function readPersistenceQueueDiagnostics(
  provider: BrokerPersistenceQueueDiagnosticsProvider | undefined,
): BrokerPersistenceQueueDiagnostics {
  if (!provider) {
    return disabledPersistenceQueueDiagnostics();
  }
  try {
    return normalizePersistenceQueueDiagnostics(provider() ?? disabledPersistenceQueueDiagnostics());
  } catch (error) {
    return unavailablePersistenceQueueDiagnostics(error);
  }
}

export function normalizePersistenceQueueDiagnostics(
  diagnostics: BrokerPersistenceQueueDiagnostics,
): BrokerPersistenceQueueDiagnostics {
  const capacity = diagnostics.capacity === null ? null : Math.max(0, Math.floor(diagnostics.capacity));
  const queued = Math.max(0, Math.floor(diagnostics.queued));
  const active = Math.max(0, Math.floor(diagnostics.active));
  const inFlight = Math.max(queued + active, Math.floor(diagnostics.inFlight));
  const available = capacity === null ? null : Math.max(0, Math.floor(diagnostics.available ?? capacity - inFlight));
  const state = diagnostics.aborted
    ? "aborted"
    : diagnostics.closing
      ? "draining"
      : diagnostics.state;
  return {
    ...diagnostics,
    kind: "broker.persistence.queue",
    capacity,
    queued,
    active,
    inFlight,
    available,
    state,
  };
}
