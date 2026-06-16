import { readFileSync } from "node:fs";

import {
  sanitizeBuildSource,
  sanitizeBuildToken,
  sanitizeImageDigest,
  sanitizeIsoTimestamp,
} from "./build-metadata-sanitize.js";
import type { BrokerBuildInfo, BrokerServerOptions } from "./server.js";

export function resolveBrokerBuildInfo(
  options: Pick<BrokerServerOptions, "buildInfoFile" | "version" | "buildRevision" | "releaseRevision">,
  serviceName: string,
): { version: string; build: BrokerBuildInfo } {
  const generated = readGeneratedBuildInfo(options.buildInfoFile);
  const version = sanitizeBuildToken(options.version ?? process.env.A2A_BROKER_VERSION ?? generated.version ?? readPackageVersion(), {
    fallback: "0.0.0",
    unsafeFallback: "0.0.0",
  }) ?? "0.0.0";
  const revision = sanitizeBuildToken(
    options.buildRevision ??
      options.releaseRevision ??
      process.env.A2A_BROKER_REVISION ??
      process.env.BROKER_RELEASE_REVISION ??
      process.env.RELEASE_REVISION ??
      generated.revision,
    { fallback: "unknown", unsafeFallback: "redacted" },
  ) ?? "unknown";
  const source = sanitizeBuildSource(process.env.A2A_BROKER_SOURCE ?? generated.source ?? "github.com/jinwon-int/a2a-nexus");
  const builtAt = sanitizeIsoTimestamp(process.env.A2A_BROKER_BUILT_AT ?? generated.builtAt);
  const runtime = sanitizeBuildToken(process.env.A2A_BROKER_RUNTIME ?? generated.runtime, {
    fallback: undefined,
    unsafeFallback: undefined,
  });
  const imageTag = sanitizeBuildToken(process.env.A2A_BROKER_IMAGE_TAG ?? generated.image?.tag, {
    fallback: undefined,
    unsafeFallback: undefined,
  });
  const imageDigest = sanitizeImageDigest(process.env.A2A_BROKER_IMAGE_DIGEST ?? generated.image?.digest);

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
  };
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
