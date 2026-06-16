const CANONICAL_BUILD_SOURCE = "github.com/jinwon-int/a2a-nexus";

export function sanitizeBrokerId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error("A2A_BROKER_ID must be a stable id using only letters, numbers, dots, underscores, colons, or hyphens");
  }
  return normalized;
}

export function sanitizeBuildToken(
  value: string | undefined,
  options: { fallback: string | undefined; unsafeFallback: string | undefined },
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return options.fallback;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(normalized)) {
    return options.unsafeFallback;
  }
  return normalized;
}

export function sanitizeBuildSource(value: string | undefined): string {
  // a2a-nexus is the canonical source of record. Anything else — empty,
  // overlong, credential-bearing, or the legacy split-repo a2a-broker label —
  // normalizes to the canonical provenance instead of leaking through.
  const normalized = value?.trim();
  if (!normalized || normalized.length > 128) {
    return CANONICAL_BUILD_SOURCE;
  }
  if (!/^(https:\/\/github\.com\/jinwon-int\/a2a-nexus|github\.com\/jinwon-int\/a2a-nexus)$/.test(normalized)) {
    return CANONICAL_BUILD_SOURCE;
  }
  return normalized.replace(/^https:\/\//, "");
}

export function sanitizeIsoTimestamp(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 32) {
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(normalized) ? normalized : undefined;
}

export function sanitizeImageDigest(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return /^sha256:[a-fA-F0-9]{64}$/.test(normalized) ? normalized.toLowerCase() : undefined;
}
