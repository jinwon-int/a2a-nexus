/**
 * W1 purpose-bound worker protocol for the V1 SQLite adapter.
 *
 * Decision W0 (`docs/specs/shared-state-ha-contract/tasks.md`) authorizes one
 * bounded FIFO lane in which a single worker owns the V1 database connection,
 * `SharedStateSqliteAdapterV1` instance, lifecycle epoch, and ownership token.
 * This module carries only the wire envelopes for that lane.
 *
 * What this protocol may carry, and nothing else:
 *   - the existing closed transaction commands (`SharedStateTransactionCommandV1`),
 *   - the two existing closed query requests (`SharedStateQueryRequestV1`),
 *   - lifecycle controls (`open`, `drain`, `close`),
 *   - a process-local scheduling ticket.
 *
 * What it must never carry:
 *   - a caller clock field. The trusted time observation that
 *     `SharedStateSqliteAdapterV1.transact` requires is taken **by the worker**
 *     that owns the adapter, at the moment of execution. It is never supplied
 *     by the main thread and never appears on this wire.
 *   - arbitrary SQL, backend commands, or generic method names.
 *   - `withTransaction(callback)`. That member's callback and its
 *     `SharedStateStorageTransactionV1` argument are functions, so they cannot
 *     cross a structured-clone boundary, and holding a SQLite transaction open
 *     across message round-trips is not this lane's shape. It is never
 *     serialized or transferred.
 *
 * The ticket is scheduling evidence only. It is not durable state, an outbox
 * sequence, an outbox receipt or acknowledgment, an idempotency key, or a
 * public field of any contract envelope.
 *
 * A narrow closed-command worker surface does not by itself implement or
 * conform to the broad `SharedStateStorageAdapterV1` interface, and this
 * module claims no such conformance.
 */
import { z } from "zod";

import {
  SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1,
  type SharedStateSqliteAdapterErrorCodeV1,
} from "./shared-state-sqlite-adapter-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateQueryResultV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  type SharedStateQueryRequestV1,
  type SharedStateQueryResultV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";

export const SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1 = Object.freeze({
  kind: "SharedStateSqliteWorkerProtocolV1",
  protocolVersion: 1,
  contractVersion: V.versions.contract,
  requestKind: "SharedStateSqliteWorkerRequestV1",
  responseKind: "SharedStateSqliteWorkerResponseV1",
  commands: Object.freeze([
    "open",
    "transact",
    "query",
    "drain",
    "close",
  ] as const),
  outcomes: Object.freeze(["value", "error"] as const),
  attachedToBrokerRuntime: false,
  fullAdapterConformanceClaimed: false,
  reusesLegacyPersistenceWorker: false,
  carriesCallerClockField: false,
  carriesWithTransactionCallback: false,
} as const);

export type SharedStateSqliteWorkerCommandV1 =
  (typeof SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.commands)[number];

export const SHARED_STATE_SQLITE_WORKER_PROTOCOL_ERROR_CODES_V1 = Object.freeze(
  [
    "malformed_envelope",
    "unknown_command",
    "invalid_ticket",
    "invalid_payload",
    "crossed_response",
  ] as const,
);

export type SharedStateSqliteWorkerProtocolErrorCodeV1 =
  (typeof SHARED_STATE_SQLITE_WORKER_PROTOCOL_ERROR_CODES_V1)[number];

export type SharedStateSqliteWorkerProtocolResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: SharedStateSqliteWorkerProtocolErrorCodeV1;
      };
    };

/**
 * Tickets are decimal strings so that a lane may outlive `Number.MAX_SAFE_INTEGER`
 * without changing the wire shape, matching how the contract already carries
 * sequences and epochs.
 */
const ticketSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,39})$/u);

const protocolCommon = {
  kind: z.literal(SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.requestKind),
  protocolVersion: z.literal(
    SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.protocolVersion,
  ),
  contractVersion: z.literal(V.versions.contract),
  ticket: ticketSchema,
};

/**
 * The payload members are deliberately `z.unknown()` here. Structural checks
 * alone would miss the contract parsers' forbidden-field rules — caller clock
 * fields, backend commands, sensitive fields — so both sides run the real
 * closed parser over the payload after the envelope shape is accepted.
 */
const sharedStateSqliteWorkerRequestEnvelopeV1Schema = z.discriminatedUnion(
  "command",
  [
    z.object({ ...protocolCommon, command: z.literal("open") }).strict(),
    z
      .object({
        ...protocolCommon,
        command: z.literal("transact"),
        transactionCommand: z.unknown(),
      })
      .strict(),
    z
      .object({
        ...protocolCommon,
        command: z.literal("query"),
        queryRequest: z.unknown(),
      })
      .strict(),
    z.object({ ...protocolCommon, command: z.literal("drain") }).strict(),
    z.object({ ...protocolCommon, command: z.literal("close") }).strict(),
  ],
);

export type SharedStateSqliteWorkerRequestV1 =
  | {
      readonly kind: typeof SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.requestKind;
      readonly protocolVersion: typeof SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.protocolVersion;
      readonly contractVersion: typeof V.versions.contract;
      readonly ticket: string;
      readonly command: "open" | "drain" | "close";
    }
  | {
      readonly kind: typeof SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.requestKind;
      readonly protocolVersion: typeof SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.protocolVersion;
      readonly contractVersion: typeof V.versions.contract;
      readonly ticket: string;
      readonly command: "transact";
      readonly transactionCommand: SharedStateTransactionCommandV1;
    }
  | {
      readonly kind: typeof SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.requestKind;
      readonly protocolVersion: typeof SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.protocolVersion;
      readonly contractVersion: typeof V.versions.contract;
      readonly ticket: string;
      readonly command: "query";
      readonly queryRequest: SharedStateQueryRequestV1;
    };

const responseCommon = {
  kind: z.literal(SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.responseKind),
  protocolVersion: z.literal(
    SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.protocolVersion,
  ),
  contractVersion: z.literal(V.versions.contract),
  ticket: ticketSchema,
  command: z.enum(SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.commands),
};

const sharedStateSqliteWorkerResponseEnvelopeV1Schema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        ...responseCommon,
        outcome: z.literal("value"),
        value: z.unknown(),
      })
      .strict(),
    z
      .object({
        ...responseCommon,
        outcome: z.literal("error"),
        error: z
          .object({
            code: z.enum(SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1),
          })
          .strict(),
      })
      .strict(),
  ],
);

/**
 * The response value union is keyed by the command the worker echoes back, so
 * a crossed or mislabelled response is detectable by the proxy rather than
 * being silently narrowed to the wrong contract family.
 */
export type SharedStateSqliteWorkerResponseValueV1 =
  | { readonly command: "open" | "drain" | "close"; readonly value: SharedStateStorageLifecycleV1 }
  | { readonly command: "transact"; readonly value: SharedStateTransactionResultV1 }
  | { readonly command: "query"; readonly value: SharedStateQueryResultV1 };

export type SharedStateSqliteWorkerResponseV1 = {
  readonly kind: typeof SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.responseKind;
  readonly protocolVersion: typeof SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.protocolVersion;
  readonly contractVersion: typeof V.versions.contract;
  readonly ticket: string;
  readonly command: SharedStateSqliteWorkerCommandV1;
} & (
  | { readonly outcome: "value"; readonly value: unknown }
  | {
      readonly outcome: "error";
      readonly error: { readonly code: SharedStateSqliteAdapterErrorCodeV1 };
    }
);

function protocolFailure<T>(
  code: SharedStateSqliteWorkerProtocolErrorCodeV1,
): SharedStateSqliteWorkerProtocolResultV1<T> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code }),
  });
}

function protocolValue<T>(
  value: T,
): SharedStateSqliteWorkerProtocolResultV1<T> {
  return Object.freeze({ ok: true as const, value });
}

/**
 * Worker-side defensive parse. A malformed envelope, an unparseable payload, or
 * a payload that the closed contract parser rejects is never admitted to the
 * adapter; the worker answers with a closed failure instead.
 */
export function parseSharedStateSqliteWorkerRequestV1(
  input: unknown,
): SharedStateSqliteWorkerProtocolResultV1<SharedStateSqliteWorkerRequestV1> {
  const envelope =
    sharedStateSqliteWorkerRequestEnvelopeV1Schema.safeParse(input);
  if (!envelope.success) {
    return protocolFailure("malformed_envelope");
  }

  const parsed = envelope.data;
  if (parsed.command === "transact") {
    const command = parseSharedStateTransactionCommandV1(
      parsed.transactionCommand,
    );
    if (!command.ok) return protocolFailure("invalid_payload");
    return protocolValue({
      kind: parsed.kind,
      protocolVersion: parsed.protocolVersion,
      contractVersion: parsed.contractVersion,
      ticket: parsed.ticket,
      command: "transact" as const,
      transactionCommand: command.value,
    });
  }

  if (parsed.command === "query") {
    const request = parseSharedStateQueryRequestV1(parsed.queryRequest);
    if (!request.ok) return protocolFailure("invalid_payload");
    return protocolValue({
      kind: parsed.kind,
      protocolVersion: parsed.protocolVersion,
      contractVersion: parsed.contractVersion,
      ticket: parsed.ticket,
      command: "query" as const,
      queryRequest: request.value,
    });
  }

  return protocolValue({
    kind: parsed.kind,
    protocolVersion: parsed.protocolVersion,
    contractVersion: parsed.contractVersion,
    ticket: parsed.ticket,
    command: parsed.command,
  });
}

/**
 * Proxy-side defensive parse of the envelope only. Payload narrowing is a
 * separate step because the proxy must first confirm that the echoed ticket and
 * command match the request it actually dispatched; a response that clears the
 * envelope but fails that match is ambiguous, not merely malformed.
 */
export function parseSharedStateSqliteWorkerResponseV1(
  input: unknown,
): SharedStateSqliteWorkerProtocolResultV1<SharedStateSqliteWorkerResponseV1> {
  const envelope =
    sharedStateSqliteWorkerResponseEnvelopeV1Schema.safeParse(input);
  if (!envelope.success) {
    return protocolFailure("malformed_envelope");
  }
  return protocolValue(envelope.data as SharedStateSqliteWorkerResponseV1);
}

/**
 * Narrows an accepted response value to the contract family the dispatched
 * command belongs to. A value that does not parse as that family, or that
 * parses as a different operation than the one requested, is refused here so
 * that the proxy can fail closed rather than hand a mismatched envelope back to
 * its caller.
 */
export function narrowSharedStateSqliteWorkerResponseValueV1(
  command: SharedStateSqliteWorkerCommandV1,
  value: unknown,
): SharedStateSqliteWorkerProtocolResultV1<SharedStateSqliteWorkerResponseValueV1> {
  if (command === "transact") {
    const parsed = parseSharedStateTransactionResultV1(value);
    if (!parsed.ok) return protocolFailure("invalid_payload");
    return protocolValue({ command, value: parsed.value });
  }
  if (command === "query") {
    const parsed = parseSharedStateQueryResultV1(value);
    if (!parsed.ok) return protocolFailure("invalid_payload");
    return protocolValue({ command, value: parsed.value });
  }
  const parsed = parseSharedStateStorageLifecycleV1(value);
  if (!parsed.ok) return protocolFailure("invalid_payload");
  return protocolValue({ command, value: parsed.value });
}

export function buildSharedStateSqliteWorkerRequestV1(
  ticket: string,
  command: "open" | "drain" | "close",
): SharedStateSqliteWorkerRequestV1;
export function buildSharedStateSqliteWorkerRequestV1(
  ticket: string,
  command: "transact",
  payload: SharedStateTransactionCommandV1,
): SharedStateSqliteWorkerRequestV1;
export function buildSharedStateSqliteWorkerRequestV1(
  ticket: string,
  command: "query",
  payload: SharedStateQueryRequestV1,
): SharedStateSqliteWorkerRequestV1;
export function buildSharedStateSqliteWorkerRequestV1(
  ticket: string,
  command: SharedStateSqliteWorkerCommandV1,
  payload?: SharedStateTransactionCommandV1 | SharedStateQueryRequestV1,
): SharedStateSqliteWorkerRequestV1 {
  const common = {
    kind: SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.requestKind,
    protocolVersion: SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.protocolVersion,
    contractVersion: V.versions.contract,
    ticket,
  } as const;

  if (command === "transact") {
    return Object.freeze({
      ...common,
      command,
      transactionCommand: payload as SharedStateTransactionCommandV1,
    });
  }
  if (command === "query") {
    return Object.freeze({
      ...common,
      command,
      queryRequest: payload as SharedStateQueryRequestV1,
    });
  }
  return Object.freeze({ ...common, command });
}

export function buildSharedStateSqliteWorkerValueResponseV1(
  ticket: string,
  command: SharedStateSqliteWorkerCommandV1,
  value: unknown,
): SharedStateSqliteWorkerResponseV1 {
  return Object.freeze({
    kind: SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.responseKind,
    protocolVersion: SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.protocolVersion,
    contractVersion: V.versions.contract,
    ticket,
    command,
    outcome: "value" as const,
    value,
  });
}

export function buildSharedStateSqliteWorkerErrorResponseV1(
  ticket: string,
  command: SharedStateSqliteWorkerCommandV1,
  code: SharedStateSqliteAdapterErrorCodeV1,
): SharedStateSqliteWorkerResponseV1 {
  return Object.freeze({
    kind: SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.responseKind,
    protocolVersion: SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.protocolVersion,
    contractVersion: V.versions.contract,
    ticket,
    command,
    outcome: "error" as const,
    error: Object.freeze({ code }),
  });
}
