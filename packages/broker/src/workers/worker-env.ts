/**
 * Worker env parsing and capability assembly (#1601 churn relief, extracted
 * from worker.ts slice 6).
 *
 * Pure env → typed-config helpers for the worker registration path:
 * broker-url/worker-id requirements, integer and list parsing, the worker
 * runtime-profile vocabulary, party role/kind parsing, built-in handler-kind
 * parsing, handler env hygiene (signature keys never reach child handlers),
 * and the WORKER_CAPABILITIES_JSON / discrete-env capability assembly with
 * the #1597 implementation-lane readiness profile. No I/O, no fetch, no
 * clock — trivially unit-testable and shared only by worker.ts.
 */

import { optionalTrimmed, parseBooleanEnv, type WorkerRuntimeProfile } from "./worker-metadata.js";
import type { BuiltinWorkerHandlerKind } from "./task-handler-factories.js";
import type {
  A2APartyKind,
  A2APartyRole,
  RegisterWorkerRequest,
} from "../core/types.js";

export type { WorkerRuntimeProfile };

export function normalizeBrokerUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function requiredEnv(env: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = optionalTrimmed(env[name]);
    if (value) {
      return value;
    }
  }
  throw new Error(`missing required env var: ${names.join(" or ")}`);
}

export function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (!optionalTrimmed(value)) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return Math.trunc(parsed);
}

export function parseBoundedSubagentCap(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return 4;
  return Math.min(4, parsed);
}

export function parseStringArrayEnv(value: string | undefined): string[] {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `expected JSON string array but received ${value}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("expected JSON string array");
  }

  return parsed.map((item) => item.trim()).filter(Boolean);
}

function parseCsvEnv(value: string | undefined): string[] {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    return [];
  }
  return [...new Set(trimmed.split(",").map((item) => item.trim()).filter(Boolean))];
}

export function buildWorkerHandlerEnv(
  env: NodeJS.ProcessEnv,
  runtimeProfile?: WorkerRuntimeProfile,
): NodeJS.ProcessEnv {
  const handlerEnv: NodeJS.ProcessEnv = {
    ...env,
    ...(runtimeProfile === "openclaw-poll-only" ? { A2A_OPENCLAW_BRIDGE_DISABLED: "1" } : {}),
  };
  delete handlerEnv.A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK;
  delete handlerEnv.WORKER_HTTP_SIGNATURE_PRIVATE_KEY_JWK;
  return handlerEnv;
}

export function parseWorkerRuntimeProfile(value: unknown): WorkerRuntimeProfile | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return undefined;
  if (normalized === "broker-poll-only" || normalized === "broker-poll-http-handler" || normalized === "poll-only") {
    return "broker-poll-only";
  }
  if (normalized === "openclaw-poll-only") return "openclaw-poll-only";
  throw new Error(`invalid worker profile: ${value}`);
}

export function parsePartyRole(value: string): A2APartyRole {
  if (
    value === "hub" ||
    value === "live-trader" ||
    value === "researcher" ||
    value === "analyst" ||
    value === "operator"
  ) {
    return value;
  }
  throw new Error(`invalid worker role: ${value}`);
}

export function parsePartyKind(value: string): A2APartyKind {
  if (value === "session" || value === "node" || value === "user" || value === "service") {
    return value;
  }
  throw new Error(`invalid requester kind: ${value}`);
}

export function parseBuiltinWorkerHandlerKind(value: string): BuiltinWorkerHandlerKind {
  if (value === "noop" || value === "echo") {
    return value;
  }
  throw new Error(`invalid built-in worker handler: ${value}`);
}

/**
 * Read the implementation-lane readiness profile (#1597) from discrete env vars.
 *
 * Values are passed through verbatim: the broker owns the single normalization
 * boundary (normalizeImplementationCapability), which coerces unknown runtimes
 * to "unknown", constrains provider/model ids to secret-safe lowercase ids, and
 * strips credential-shaped evidence. Normalizing here as well would create a
 * second place for those rules to drift.
 *
 * Returns undefined when nothing is declared, which keeps legacy workers
 * registering exactly as before and simply ineligible for implementation work.
 */
type DeclaredImplementationCapability = NonNullable<
  RegisterWorkerRequest["capabilities"]["implementationCapability"]
>;

/**
 * Cast a declared-but-unnormalized profile onto the wire type. The broker
 * rejects or coerces every field on arrival, so the worker deliberately does not
 * pre-fill `runtime` or `availability` here — inventing a default would publish
 * a readiness claim the operator never made.
 */
function asDeclaredImplementationCapability(
  value: Record<string, unknown>,
): DeclaredImplementationCapability {
  return value as unknown as DeclaredImplementationCapability;
}

function parseImplementationCapabilityEnv(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const capable = parseOptionalBoolean(
    env.WORKER_IMPLEMENTATION_CAPABLE ?? env.A2A_WORKER_IMPLEMENTATION_CAPABLE,
  );
  if (capable === undefined) return undefined;

  const runtime = optionalTrimmed(env.WORKER_IMPLEMENTATION_RUNTIME ?? env.A2A_WORKER_IMPLEMENTATION_RUNTIME);
  const providerId = optionalTrimmed(env.WORKER_IMPLEMENTATION_PROVIDER_ID ?? env.A2A_WORKER_IMPLEMENTATION_PROVIDER_ID);
  const modelTier = optionalTrimmed(env.WORKER_IMPLEMENTATION_MODEL_TIER ?? env.A2A_WORKER_IMPLEMENTATION_MODEL_TIER);
  const availability = optionalTrimmed(env.WORKER_IMPLEMENTATION_AVAILABILITY ?? env.A2A_WORKER_IMPLEMENTATION_AVAILABILITY);
  const lastVerifiedAt = optionalTrimmed(env.WORKER_IMPLEMENTATION_LAST_VERIFIED_AT ?? env.A2A_WORKER_IMPLEMENTATION_LAST_VERIFIED_AT);
  const evidenceId = optionalTrimmed(env.WORKER_IMPLEMENTATION_EVIDENCE_ID ?? env.A2A_WORKER_IMPLEMENTATION_EVIDENCE_ID);

  return {
    capable,
    ...(runtime ? { runtime } : {}),
    ...(providerId ? { providerId } : {}),
    ...(modelTier ? { modelTier } : {}),
    ...(availability ? { availability } : {}),
    ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
    ...(evidenceId ? { evidenceId } : {}),
  };
}

export function parseWorkerCapabilities(
  env: NodeJS.ProcessEnv,
  role: A2APartyRole,
): RegisterWorkerRequest["capabilities"] {
  const capabilitiesJson = optionalTrimmed(env.WORKER_CAPABILITIES_JSON ?? env.A2A_WORKER_CAPABILITIES_JSON);
  if (capabilitiesJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(capabilitiesJson);
    } catch (error) {
      throw new Error(
        `WORKER_CAPABILITIES_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("WORKER_CAPABILITIES_JSON must be a JSON object");
    }

    const record = parsed as Record<string, unknown>;
    const runtimeFlavor = parseWorkerRuntimeFlavor(record.runtimeFlavor);
    const gatewayRequired = parseOptionalBoolean(record.gatewayRequired);
    // Discrete env vars win over the JSON blob so an operator can add or revoke
    // readiness without rewriting a whole capabilities document.
    const implementationCapability = parseImplementationCapabilityEnv(env)
      ?? (record.implementationCapability && typeof record.implementationCapability === "object" &&
          !Array.isArray(record.implementationCapability)
        ? record.implementationCapability as Record<string, unknown>
        : undefined);
    return {
      canAnalyze: Boolean(record.canAnalyze),
      canBackfill: Boolean(record.canBackfill),
      canPatchWorkspace: Boolean(record.canPatchWorkspace),
      canPromoteLive: Boolean(record.canPromoteLive),
      workspaceIds: Array.isArray(record.workspaceIds)
        ? record.workspaceIds.map((item) => String(item)).filter(Boolean)
        : [],
      environments: Array.isArray(record.environments)
        ? record.environments
            .map((item) => String(item))
            .filter(isWorkerEnvironment)
        : [],
      ...(runtimeFlavor ? { runtimeFlavor } : {}),
      ...(gatewayRequired !== undefined ? { gatewayRequired } : {}),
      ...(implementationCapability
        ? { implementationCapability: asDeclaredImplementationCapability(implementationCapability) }
        : {}),
    };
  }

  const declaredImplementationCapability = parseImplementationCapabilityEnv(env);
  return {
    canAnalyze: parseBooleanEnv(env.WORKER_CAN_ANALYZE ?? env.A2A_WORKER_CAN_ANALYZE, role === "analyst" || role === "researcher"),
    canBackfill: parseBooleanEnv(env.WORKER_CAN_BACKFILL ?? env.A2A_WORKER_CAN_BACKFILL, false),
    canPatchWorkspace: parseBooleanEnv(env.WORKER_CAN_PATCH_WORKSPACE ?? env.A2A_WORKER_CAN_PATCH_WORKSPACE, false),
    canPromoteLive: parseBooleanEnv(env.WORKER_CAN_PROMOTE_LIVE ?? env.A2A_WORKER_CAN_PROMOTE_LIVE, false),
    workspaceIds: parseCsvEnv(env.WORKER_WORKSPACE_IDS ?? env.A2A_WORKER_WORKSPACE_IDS),
    environments: parseCsvEnv(env.WORKER_ENVIRONMENTS ?? env.A2A_WORKER_ENVIRONMENTS).filter(isWorkerEnvironment),
    ...(parseWorkerRuntimeFlavor(env.WORKER_RUNTIME_FLAVOR ?? env.A2A_WORKER_RUNTIME_FLAVOR) ? { runtimeFlavor: parseWorkerRuntimeFlavor(env.WORKER_RUNTIME_FLAVOR ?? env.A2A_WORKER_RUNTIME_FLAVOR) } : {}),
    ...(parseOptionalBoolean(env.WORKER_GATEWAY_REQUIRED ?? env.A2A_WORKER_GATEWAY_REQUIRED) !== undefined ? { gatewayRequired: parseOptionalBoolean(env.WORKER_GATEWAY_REQUIRED ?? env.A2A_WORKER_GATEWAY_REQUIRED) } : {}),
    ...(declaredImplementationCapability
      ? { implementationCapability: asDeclaredImplementationCapability(declaredImplementationCapability) }
      : {}),
  };
}

export function applyWorkerRuntimeProfile(
  capabilities: RegisterWorkerRequest["capabilities"],
  runtimeProfile?: WorkerRuntimeProfile,
): RegisterWorkerRequest["capabilities"] {
  if (!runtimeProfile) {
    return capabilities;
  }
  const requiredRuntimeFlavor = runtimeProfile === "openclaw-poll-only"
    ? "openclaw-poll-handler"
    : "broker-poll-http-handler";
  if (capabilities.runtimeFlavor && capabilities.runtimeFlavor !== requiredRuntimeFlavor) {
    throw new Error(
      `A2A_WORKER_PROFILE=${runtimeProfile} requires runtimeFlavor=${requiredRuntimeFlavor}, got ${capabilities.runtimeFlavor}`,
    );
  }
  if (capabilities.gatewayRequired === true) {
    throw new Error(`A2A_WORKER_PROFILE=${runtimeProfile} requires gatewayRequired=false`);
  }
  return {
    ...capabilities,
    runtimeFlavor: requiredRuntimeFlavor,
    gatewayRequired: false,
  };
}

function isWorkerEnvironment(value: string): value is RegisterWorkerRequest["capabilities"]["environments"][number] {
  return value === "research" || value === "staging" || value === "live";
}

function parseWorkerRuntimeFlavor(value: unknown): RegisterWorkerRequest["capabilities"]["runtimeFlavor"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (
    normalized === "gateway" ||
    normalized === "termux-hermes" ||
    normalized === "broker-poll-http-handler" ||
    normalized === "openclaw-poll-handler"
  ) return normalized;
  if (normalized === "hermes") return "termux-hermes";
  if (normalized === "broker-poll-only" || normalized === "broker-poll-handler" || normalized === "poll-only") {
    return "broker-poll-http-handler";
  }
  if (normalized === "openclaw-poll-only") {
    return "openclaw-poll-handler";
  }
  if (normalized.length > 0) return "unknown";
  return undefined;
}

export function parseWorkerMode(value: unknown): RegisterWorkerRequest["workerMode"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "persistent" || normalized === "mobile") return normalized;
  return undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}
