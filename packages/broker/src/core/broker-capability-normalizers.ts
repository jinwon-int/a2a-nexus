// Worker capability and provider-capability value normalizers extracted from
// broker.ts. Pure functions over untrusted input that sanitize and canonicalize
// worker capability fields (runtime flavor, provider capabilities, environment
// lists). They hold no broker state and depend only on capability types.
import type { WorkerCapabilities, A2AWorkerEnvironment } from "./types.js";

export function normalizeWorkerRuntimeFlavor(value: unknown): WorkerCapabilities["runtimeFlavor"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "gateway" || normalized === "termux-hermes" || normalized === "openclaw-poll-handler") {
    return normalized;
  }
  if (normalized === "hermes") return "termux-hermes";
  if (normalized === "openclaw-poll-only" || normalized === "broker-poll-handler" || normalized === "poll-only") {
    return "openclaw-poll-handler";
  }
  if (normalized.length > 0) return "unknown";
  return undefined;
}

export function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

export function normalizeProviderCapabilities(values: unknown): NonNullable<WorkerCapabilities["providerCapabilities"]> {
  if (!Array.isArray(values)) return [];
  const normalized: NonNullable<WorkerCapabilities["providerCapabilities"]> = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const providerId = normalizeProviderCapabilityId(record.providerId);
    if (!providerId) continue;
    const routeKind = normalizeProviderRouteKind(record.routeKind);
    const availability = normalizeProviderAvailability(record.availability);
    const capability = {
      providerId,
      ...(normalizeProviderCapabilityId(record.modelFamily) ? { modelFamily: normalizeProviderCapabilityId(record.modelFamily) } : {}),
      ...(normalizeProviderCapabilityId(record.modelId) ? { modelId: normalizeProviderCapabilityId(record.modelId) } : {}),
      routeKind,
      availability,
      ...(normalizeProviderEvidenceString(record.lastVerifiedAt) ? { lastVerifiedAt: normalizeProviderEvidenceString(record.lastVerifiedAt) } : {}),
      ...(normalizeProviderEvidenceString(record.evidenceId) ? { evidenceId: normalizeProviderEvidenceString(record.evidenceId) } : {}),
    };
    const key = JSON.stringify([capability.providerId, capability.modelFamily, capability.modelId, capability.routeKind]);
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(capability);
    }
  }
  return normalized;
}

export function normalizeProviderCapabilityId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:/+-]{0,63}$/.test(normalized)) return undefined;
  if (/(secret|token|password|credential|private[_-]?key|api[_-]?key|oauth\.json)/i.test(normalized)) return undefined;
  return normalized;
}

export function normalizeProviderEvidenceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) return undefined;
  if (/(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{16,}|secret|token|password|credential|private[_-]?key|api[_-]?key)/i.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function normalizeProviderRouteKind(value: unknown): NonNullable<WorkerCapabilities["providerCapabilities"]>[number]["routeKind"] {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "subscription" || normalized === "oauth" || normalized === "api-key") return normalized;
  return "unknown";
}

export function normalizeProviderAvailability(value: unknown): NonNullable<WorkerCapabilities["providerCapabilities"]>[number]["availability"] {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    normalized === "configured" ||
    normalized === "canary_passed" ||
    normalized === "entitlement_failed" ||
    normalized === "disabled"
  ) {
    return normalized;
  }
  return "configured";
}

export function uniqueStringList(values: unknown): string[] {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => String(value)).filter(Boolean))]
    : [];
}

export function uniqueEnvironmentList(values: unknown): A2AWorkerEnvironment[] {
  return uniqueStringList(values).filter(isA2AWorkerEnvironment);
}

export function isA2AWorkerEnvironment(value: string): value is A2AWorkerEnvironment {
  return value === "research" || value === "staging" || value === "live";
}
