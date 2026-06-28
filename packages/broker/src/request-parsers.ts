// Request body/identity parsing and validation helpers extracted from server.ts.
// Pure functions that read optional fields, validate task-request parties, parse
// terminal-outbox ack/receipt inputs, and authorize worker-assignment
// subscriptions; validation failures throw BrokerError. Kept in src/ so the
// ./core/* import specifiers stay valid unchanged.
import { BrokerError } from "./core/broker-error.js";
import {
  isTerminalTaskOutboxAckInputEvidence,
  isTerminalTaskReceiptStatus,
} from "./core/terminal-event-outbox.js";
import type { CreateTaskRequest } from "./core/types.js";
import type { RequesterIdentity } from "./core/request-security.js";
import type {
  TerminalTaskOutboxAckInput,
  TerminalTaskOutboxAckInputEvidence,
  TerminalTaskOutboxReceiptUpdateInput,
  TerminalTaskReceiptStatus,
} from "./core/terminal-event-outbox.js";

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function assertCreateTaskRequestParties(body: CreateTaskRequest): void {
  assertRequestParty(body.requester, "requester");
  assertRequestParty(body.target, "target");
}

export function assertRequestParty(value: unknown, field: "requester" | "target"): void {
  if (!value || typeof value !== "object") {
    throw new BrokerError("bad_request", `${field}.id is required`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    throw new BrokerError("bad_request", `${field}.id is required`);
  }
}

export function optionalEnum<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim() as T;
  return allowed.includes(normalized) ? normalized : undefined;
}

export function parseTerminalOutboxAckReceipt(value: unknown): TerminalTaskOutboxAckInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError(
      "bad_request",
      "terminal outbox ack requires receipt evidence; Gateway/provider send success alone is not accepted",
    );
  }
  const receipt = value as Record<string, unknown>;
  if (!isTerminalTaskOutboxAckInputEvidence(receipt.evidence)) {
    throw new BrokerError(
      "bad_request",
      "terminal outbox ack evidence must be current_session_visible, operator_visible, or operator_confirmed",
    );
  }
  return {
    evidence: receipt.evidence,
    acknowledgedAt: typeof receipt.acknowledgedAt === "string" ? receipt.acknowledgedAt : undefined,
    receiptId: typeof receipt.receiptId === "string" ? receipt.receiptId : undefined,
    note: typeof receipt.note === "string" ? receipt.note : undefined,
  };
}

export function parseTerminalOutboxReceiptUpdate(value: unknown): TerminalTaskOutboxReceiptUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("bad_request", "terminal outbox receipt update requires a receipt object");
  }
  const receipt = value as Record<string, unknown>;
  if (!isTerminalTaskReceiptStatus(receipt.status)) {
    throw new BrokerError(
      "bad_request",
      "terminal outbox receipt status must be accepted, started, produced, provider_sent, provider_accepted, current_session_visible, operator_visible, timed_out, stale, or failed",
    );
  }
  return {
    status: receipt.status,
    updatedAt: typeof receipt.updatedAt === "string" ? receipt.updatedAt : undefined,
    note: typeof receipt.note === "string" ? receipt.note : undefined,
  };
}

export function assertRequesterCanSubscribeToWorkerAssignments(
  identity: RequesterIdentity | null,
  workerId: string,
): void {
  if (!identity?.id) {
    throw new BrokerError("unauthorized", "x-a2a-requester-id is required for this route");
  }
  if (identity.role === "hub" || identity.role === "operator" || identity.id === workerId) {
    return;
  }
  throw new BrokerError(
    "unauthorized",
    "worker assignment subscribe requires the assigned worker requester or a hub/operator role",
  );
}
