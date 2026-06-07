/**
 * Plugin-local AJV validators for A2A gateway method params.
 */
import AjvPkg, { type ErrorObject } from "ajv";
import type {
  A2ATaskApproveParams,
  A2ATaskCancelParams,
  A2ATaskRejectApprovalParams,
  A2ATaskRequestParams,
  A2ATaskStatusParams,
  A2ATaskUpdateParams,
  A2AAlertsListParams,
  A2AMonitorStatusParams,
  A2APeerStatusParams,
} from "./gateway-schema.js";
import {
  A2ATaskApproveParamsSchema,
  A2ATaskCancelParamsSchema,
  A2ATaskRejectApprovalParamsSchema,
  A2ATaskRequestParamsSchema,
  A2ATaskStatusParamsSchema,
  A2ATaskUpdateParamsSchema,
  A2AAlertsListParamsSchema,
  A2AMonitorStatusParamsSchema,
  A2APeerStatusParamsSchema,
} from "./gateway-schema.js";

type Validator<T> = ((data: unknown) => data is T) & {
  errors?: ErrorObject[] | null;
};

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateA2ATaskRequestParams = ajv.compile<A2ATaskRequestParams>(
  A2ATaskRequestParamsSchema,
) as Validator<A2ATaskRequestParams>;
export const validateA2ATaskUpdateParams = ajv.compile<A2ATaskUpdateParams>(
  A2ATaskUpdateParamsSchema,
) as Validator<A2ATaskUpdateParams>;
export const validateA2ATaskCancelParams = ajv.compile<A2ATaskCancelParams>(
  A2ATaskCancelParamsSchema,
) as Validator<A2ATaskCancelParams>;
export const validateA2ATaskApproveParams = ajv.compile<A2ATaskApproveParams>(
  A2ATaskApproveParamsSchema,
) as Validator<A2ATaskApproveParams>;
export const validateA2ATaskRejectApprovalParams = ajv.compile<A2ATaskRejectApprovalParams>(
  A2ATaskRejectApprovalParamsSchema,
) as Validator<A2ATaskRejectApprovalParams>;
export const validateA2ATaskStatusParams = ajv.compile<A2ATaskStatusParams>(
  A2ATaskStatusParamsSchema,
) as Validator<A2ATaskStatusParams>;
export const validateA2AAlertsListParams = ajv.compile<A2AAlertsListParams>(
  A2AAlertsListParamsSchema,
) as Validator<A2AAlertsListParams>;
export const validateA2AMonitorStatusParams = ajv.compile<A2AMonitorStatusParams>(
  A2AMonitorStatusParamsSchema,
) as Validator<A2AMonitorStatusParams>;
export const validateA2APeerStatusParams = ajv.compile<A2APeerStatusParams>(
  A2APeerStatusParamsSchema,
) as Validator<A2APeerStatusParams>;

/**
 * Minimal validation helper — replaces core assertValidParams.
 * Returns true if valid; returns an error object if not.
 */
/**
 * Redact sessionKey values from an AJV error message.
 * Returns the safe label (<missing>, <empty>, <present>); the original
 * error for any other path is passed through as-is.
 */
function redactSessionKeyError(e: ErrorObject): string {
  const path = e.instancePath || "/";

  // Missing required property
  if (
    (e.params as Record<string, unknown>)?.missingProperty === "sessionKey"
  ) {
    return `/${(e.params as Record<string, unknown>).missingProperty}: <missing>`;
  }

  // Any path ending in "/sessionKey" (top-level or nested)
  if (path.endsWith("/sessionKey")) {
    // minLength violation => empty string
    if (e.keyword === "minLength") {
      return `${path}: <empty>`;
    }
    // Any other violation (type mismatch, etc.) — value is present but invalid
    return `${path}: <present>`;
  }

  return `${path}: ${e.message}`;
}

/**
 * Minimal validation helper — replaces core assertValidParams.
 * Returns true if valid; returns an error object if not.
 *
 * SessionKey values are never included in error messages.  Missing/empty
 * sessionKey shows "<missing>" / "<empty>"; any present (but possibly
 * invalid) sessionKey shows "<present>".
 */
export function validateParams<T>(
  params: unknown,
  validate: Validator<T>,
  method: string,
): { valid: true; data: T } | { valid: false; error: { code: string; message: string } } {
  if (validate(params)) {
    return { valid: true, data: params };
  }
  const errors = validate.errors
    ?.map(redactSessionKeyError)
    .join("; ");
  return {
    valid: false,
    error: { code: "INVALID_REQUEST", message: `invalid ${method} params: ${errors || "unknown"}` },
  };
}
