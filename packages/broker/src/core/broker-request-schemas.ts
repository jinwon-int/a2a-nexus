// Inbound request schemas DERIVED from the persisted-state schemas.
//
// Background (#1504, #1725 class of failure): create-time validation used
// hand-written truthiness checks (`if (!request.summary)`) while the snapshot
// loader validates the same records with strict zod schemas
// (`store-schemas.ts`). Anything the request check let through but the store
// schema rejects — a numeric `kind`, an empty-string `kind`, a `sizeBytes`
// string, a nested `metrics` value — was accepted, persisted, and then made
// `parseSnapshotPayload` throw on the next start: the broker could no longer
// boot, and the `.bak` copy was overwritten with the same poison on the next
// save.
//
// Deriving the request schemas from the store schemas removes the class of
// drift by construction: a field can only be accepted at the edge if the
// persistence layer would accept it. Server-owned fields (ids, timestamps,
// status) are omitted, and client-optional fields are relaxed explicitly.
import { z } from "zod";

import { BrokerError } from "./broker-error.js";
import { artifactSchema, proposalSchema, validationSchema } from "./store-schemas.js";

/**
 * POST /proposals body.
 *
 * Derived from {@link proposalSchema} minus the broker-assigned fields
 * (`id`, `sourceNodeId`/`targetNodeId` mirrors, `status`, timestamps).
 * `artifactIds` is optional on the request (the writer defaults it to `[]`).
 */
export const createProposalRequestSchema = proposalSchema
  .omit({
    id: true,
    sourceNodeId: true,
    targetNodeId: true,
    artifactIds: true,
    status: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    artifactIds: z.array(z.string().min(1)).optional(),
  });

/**
 * POST /proposals/:id/artifacts body. Derived from {@link artifactSchema} minus
 * the broker-assigned `id`, `proposalId` (taken from the path) and `createdAt`.
 */
export const attachArtifactRequestSchema = artifactSchema.omit({
  id: true,
  proposalId: true,
  createdAt: true,
});

/**
 * POST /proposals/:id/validate body. Derived from {@link validationSchema};
 * `metrics`/`artifactIds` are optional on the request (the writer defaults them).
 */
export const submitValidationRequestSchema = validationSchema
  .omit({
    id: true,
    proposalId: true,
    metrics: true,
    artifactIds: true,
    createdAt: true,
  })
  .extend({
    metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    artifactIds: z.array(z.string().min(1)).optional(),
  });

/** Format zod issues into one compact, operator-safe message. */
export function formatRequestIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Shared request-validation helper for broker write paths.
 *
 * Throws `BrokerError("bad_request", ...)` — the same error class the existing
 * hand-written checks throw — so HTTP/JSON-RPC error mapping is unchanged and
 * callers still receive 400, never a 500 or a poisoned snapshot.
 */
export function assertRequestPayload<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  label: string,
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BrokerError("bad_request", `${label} rejected: ${formatRequestIssues(parsed.error)}`);
  }
  return parsed.data;
}
