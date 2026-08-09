import { readFileSync } from "node:fs";

import {
  sanitizeBuildSource,
  sanitizeBuildToken,
  sanitizeImageDigest,
  sanitizeIsoTimestamp,
} from "./build-metadata-sanitize.js";
import type { BrokerBuildInfo, BrokerBuildProvenanceConflict, BrokerServerOptions } from "./server.js";

type Sanitizer<T> = (raw: string | undefined) => T | undefined;

/**
 * #1772: image-baked provenance outranks ambient host environment.
 *
 * Provenance describes the artifact, so the only copy that can be trusted is
 * the one generated *inside* the image build from verified build args —
 * `dist/build-info.json`, written by `generate-build-info.mjs`, which #1770
 * taught to fail closed when git can prove the claim wrong. A value sitting in
 * the deployment host's environment cannot describe the image it happens to be
 * running.
 *
 * This used to be backwards: `process.env` was consulted first and the baked
 * value was the fallback. Because `docker-compose.yml` injects the whole
 * `.env` over the image's own ENV via `env_file:`, a single stale line made
 * `/health.build.revision` advertise a commit the image was never built from —
 * for a month on the T2 broker, and with a three-way disagreement (label vs
 * reported revision vs image tag) on the T1 production broker. The image label
 * was correct in both cases, so label-only verification did not catch it.
 *
 * Env remains the fallback for non-docker and dev runs, where nothing is
 * baked. When both exist and disagree, the baked value wins and the conflict
 * is reported (see `BrokerBuildProvenanceConflict`) rather than swallowed.
 */
export function resolveBrokerBuildInfo(
  options: Pick<BrokerServerOptions, "buildInfoFile" | "version" | "buildRevision" | "releaseRevision">,
  serviceName: string,
): { version: string; build: BrokerBuildInfo; provenanceConflicts: BrokerBuildProvenanceConflict[] } {
  const generated = readGeneratedBuildInfo(options.buildInfoFile);
  const conflicts: BrokerBuildProvenanceConflict[] = [];

  const token = (raw: string | undefined): string | undefined =>
    sanitizeBuildToken(raw, { fallback: undefined, unsafeFallback: undefined });

  const version = firstSanitized(token, [
    options.version,
    generated.version,
    process.env.A2A_BROKER_VERSION,
    readPackageVersion(),
  ]).value ?? "0.0.0";
  record(conflicts, "version", "A2A_BROKER_VERSION", token, generated.version, process.env.A2A_BROKER_VERSION);

  // `unknown` (nothing was supplied) and `redacted` (something was supplied
  // but did not survive sanitization) are distinct operator signals — the
  // latter means a credential-bearing or malformed value reached the config
  // and must not be quietly downgraded to "absent".
  const resolvedRevision = firstSanitized(token, [
    options.buildRevision,
    options.releaseRevision,
    generated.revision,
    process.env.A2A_BROKER_REVISION,
    process.env.BROKER_RELEASE_REVISION,
    process.env.RELEASE_REVISION,
  ]);
  const revision = resolvedRevision.value ?? (resolvedRevision.sawUnsafe ? "redacted" : "unknown");
  record(conflicts, "revision", "A2A_BROKER_REVISION", token, generated.revision, process.env.A2A_BROKER_REVISION);

  // sanitizeBuildSource always normalizes to the canonical repo, so a host
  // override can never introduce a different source and needs no conflict row.
  const source = sanitizeBuildSource(generated.source ?? process.env.A2A_BROKER_SOURCE);

  const builtAt = firstSanitized(sanitizeIsoTimestamp, [generated.builtAt, process.env.A2A_BROKER_BUILT_AT]).value;
  record(conflicts, "builtAt", "A2A_BROKER_BUILT_AT", sanitizeIsoTimestamp, generated.builtAt, process.env.A2A_BROKER_BUILT_AT);

  const runtime = firstSanitized(token, [generated.runtime, process.env.A2A_BROKER_RUNTIME]).value;
  record(conflicts, "runtime", "A2A_BROKER_RUNTIME", token, generated.runtime, process.env.A2A_BROKER_RUNTIME);

  const imageTag = firstSanitized(token, [generated.image?.tag, process.env.A2A_BROKER_IMAGE_TAG]).value;
  record(conflicts, "imageTag", "A2A_BROKER_IMAGE_TAG", token, generated.image?.tag, process.env.A2A_BROKER_IMAGE_TAG);

  const imageDigest = firstSanitized(sanitizeImageDigest, [generated.image?.digest, process.env.A2A_BROKER_IMAGE_DIGEST]).value;
  record(
    conflicts,
    "imageDigest",
    "A2A_BROKER_IMAGE_DIGEST",
    sanitizeImageDigest,
    generated.image?.digest,
    process.env.A2A_BROKER_IMAGE_DIGEST,
  );

  const image = imageTag || imageDigest ? { ...(imageTag ? { tag: imageTag } : {}), ...(imageDigest ? { digest: imageDigest } : {}) } : undefined;

  return {
    version,
    build: {
      component: serviceName,
      revision,
      source,
      ...(builtAt ? { builtAt } : {}),
      ...(runtime ? { runtime } : {}),
      ...(image ? { image } : {}),
    },
    provenanceConflicts: conflicts,
  };
}

/**
 * Sanitize each candidate in order and take the first that survives.
 *
 * The previous `a ?? b` chain sanitized only the winner of the nullish
 * coalescing, so a *malformed* env value beat a valid baked one and then
 * sanitized away to `undefined` — erasing provenance entirely instead of
 * falling through. Sanitizing per candidate makes an unusable value fall to
 * the next source rather than blanking the field.
 */
function firstSanitized<T>(
  sanitize: Sanitizer<T>,
  candidates: Array<string | undefined>,
): { value: T | undefined; sawUnsafe: boolean } {
  let sawUnsafe = false;
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate.trim() === "") {
      continue;
    }
    const sanitized = sanitize(candidate);
    if (sanitized !== undefined) {
      return { value: sanitized, sawUnsafe };
    }
    // Present but unusable: remember it so callers can distinguish "nothing
    // was configured" from "something was configured and had to be dropped".
    sawUnsafe = true;
  }
  return { value: undefined, sawUnsafe };
}

/** Record a host env value that contradicts a usable image-baked value. */
function record<T>(
  into: BrokerBuildProvenanceConflict[],
  field: BrokerBuildProvenanceConflict["field"],
  envVar: string,
  sanitize: Sanitizer<T>,
  bakedRaw: string | undefined,
  envRaw: string | undefined,
): void {
  if (envRaw === undefined || envRaw.trim() === "" || bakedRaw === undefined) {
    return;
  }
  const baked = sanitize(bakedRaw);
  if (baked === undefined) {
    // Nothing authoritative to contradict; env legitimately supplies the value.
    return;
  }
  const fromEnv = sanitize(envRaw);
  if (fromEnv !== undefined && String(fromEnv) === String(baked)) {
    return;
  }
  into.push({
    field,
    envVar,
    ignored: fromEnv === undefined ? "redacted" : String(fromEnv),
    authoritative: String(baked),
  });
}

export function readGeneratedBuildInfo(path?: string): Partial<BrokerBuildInfo & { version: string }> {
  const candidates = path ? [path] : [new URL("./build-info.json", import.meta.url)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<BrokerBuildInfo & { version: string }>;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Generated build-info is optional in local/dev runs.
    }
  }
  return {};
}

export function readPackageVersion(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return parsed.version;
  } catch {
    return undefined;
  }
}
