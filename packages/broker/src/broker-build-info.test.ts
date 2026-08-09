import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

import {
  readGeneratedBuildInfo,
  readPackageVersion,
  resolveBrokerBuildInfo,
} from "./broker-build-info.js";

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("readGeneratedBuildInfo returns parsed build info from an explicit file", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-build-info-"));
  try {
    const file = join(dir, "build-info.json");
    writeFileSync(file, JSON.stringify({
      version: "1.2.3",
      revision: "abc123",
      source: "github.com/jinwon-int/a2a-nexus",
      builtAt: "2026-06-16T10:00:00Z",
      runtime: "docker",
      image: { tag: "a2a-broker:abc123" },
    }));

    assert.deepEqual(readGeneratedBuildInfo(file), {
      version: "1.2.3",
      revision: "abc123",
      source: "github.com/jinwon-int/a2a-nexus",
      builtAt: "2026-06-16T10:00:00Z",
      runtime: "docker",
      image: { tag: "a2a-broker:abc123" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGeneratedBuildInfo tolerates missing or invalid optional files", () => {
  assert.deepEqual(readGeneratedBuildInfo("/path/that/does/not/exist.json"), {});

  const dir = mkdtempSync(join(tmpdir(), "broker-build-info-invalid-"));
  try {
    const file = join(dir, "build-info.json");
    writeFileSync(file, "not json");
    assert.deepEqual(readGeneratedBuildInfo(file), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPackageVersion reads the broker package version", () => {
  assert.match(readPackageVersion() ?? "", /^\d+\.\d+\.\d+/);
});

const BAKED = {
  version: "9.9.9",
  revision: "generated123",
  source: "github.com/jinwon-int/a2a-nexus",
  builtAt: "2026-06-16T10:00:00Z",
  runtime: "docker",
  image: { tag: "a2a-broker:generated123", digest: "sha256:" + "a".repeat(64) },
};

function withBakedBuildInfo(baked: unknown, fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "broker-build-info-resolve-"));
  try {
    const file = join(dir, "build-info.json");
    writeFileSync(file, JSON.stringify(baked));
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * #1772 regression. This previously asserted the opposite — that
 * `A2A_BROKER_REVISION` from the host env beat the revision baked into the
 * image — which is exactly the defect: `docker-compose.yml` injects `.env`
 * over the image's own ENV, so one stale line made /health advertise a commit
 * the image was never built from (a month on T2; a three-way disagreement on
 * the T1 production broker).
 */
test("resolveBrokerBuildInfo prefers image-baked provenance over contradicting host env", () => {
  withBakedBuildInfo(BAKED, (file) => {
    withEnv({
      A2A_BROKER_VERSION: undefined,
      A2A_BROKER_REVISION: "envrev456",
      BROKER_RELEASE_REVISION: undefined,
      RELEASE_REVISION: undefined,
      A2A_BROKER_SOURCE: "https://credential.example.invalid/private/repo.git",
      A2A_BROKER_BUILT_AT: "2026-07-06T06:53:22Z",
      A2A_BROKER_RUNTIME: "docker",
      A2A_BROKER_IMAGE_TAG: "a2a-broker:envtag456",
      A2A_BROKER_IMAGE_DIGEST: "sha256:" + "b".repeat(64),
    }, () => {
      const resolved = resolveBrokerBuildInfo({ buildInfoFile: file }, "a2a-broker");

      assert.deepEqual(resolved.build, {
        component: "a2a-broker",
        revision: "generated123",
        source: "github.com/jinwon-int/a2a-nexus",
        builtAt: "2026-06-16T10:00:00Z",
        runtime: "docker",
        image: { tag: "a2a-broker:generated123", digest: "sha256:" + "a".repeat(64) },
      });
      assert.equal(resolved.version, "9.9.9");

      // The disagreement is reported, not swallowed.
      assert.deepEqual(
        resolved.provenanceConflicts.map((c) => [c.field, c.envVar, c.ignored, c.authoritative]),
        [
          ["revision", "A2A_BROKER_REVISION", "envrev456", "generated123"],
          ["builtAt", "A2A_BROKER_BUILT_AT", "2026-07-06T06:53:22Z", "2026-06-16T10:00:00Z"],
          ["imageTag", "A2A_BROKER_IMAGE_TAG", "a2a-broker:envtag456", "a2a-broker:generated123"],
          ["imageDigest", "A2A_BROKER_IMAGE_DIGEST", "sha256:" + "b".repeat(64), "sha256:" + "a".repeat(64)],
        ],
      );
    });
  });
});

test("resolveBrokerBuildInfo reports no conflict when host env agrees with the image", () => {
  withBakedBuildInfo(BAKED, (file) => {
    withEnv({
      A2A_BROKER_VERSION: "9.9.9",
      A2A_BROKER_REVISION: "generated123",
      BROKER_RELEASE_REVISION: undefined,
      RELEASE_REVISION: undefined,
      A2A_BROKER_BUILT_AT: "2026-06-16T10:00:00Z",
      A2A_BROKER_RUNTIME: "docker",
      A2A_BROKER_IMAGE_TAG: "a2a-broker:generated123",
      A2A_BROKER_IMAGE_DIGEST: "sha256:" + "a".repeat(64),
    }, () => {
      const resolved = resolveBrokerBuildInfo({ buildInfoFile: file }, "a2a-broker");
      assert.deepEqual(resolved.provenanceConflicts, []);
      assert.equal(resolved.build.revision, "generated123");
    });
  });
});

/**
 * Non-docker and dev runs bake nothing, so env is still the supplier there.
 * Only a *contradiction* is overridden — absence is not a contradiction.
 */
test("resolveBrokerBuildInfo falls back to host env when nothing is baked", () => {
  withBakedBuildInfo({}, (file) => {
    withEnv({
      A2A_BROKER_VERSION: "1.2.3",
      A2A_BROKER_REVISION: "envrev456",
      BROKER_RELEASE_REVISION: undefined,
      RELEASE_REVISION: undefined,
      A2A_BROKER_BUILT_AT: "2026-07-06T06:53:22Z",
      A2A_BROKER_RUNTIME: "bare",
      A2A_BROKER_IMAGE_TAG: "a2a-broker:envtag456",
      A2A_BROKER_IMAGE_DIGEST: "sha256:" + "b".repeat(64),
    }, () => {
      const resolved = resolveBrokerBuildInfo({ buildInfoFile: file }, "a2a-broker");
      assert.deepEqual(resolved.build, {
        component: "a2a-broker",
        revision: "envrev456",
        source: "github.com/jinwon-int/a2a-nexus",
        builtAt: "2026-07-06T06:53:22Z",
        runtime: "bare",
        image: { tag: "a2a-broker:envtag456", digest: "sha256:" + "b".repeat(64) },
      });
      assert.equal(resolved.version, "1.2.3");
      assert.deepEqual(resolved.provenanceConflicts, []);
    });
  });
});

/**
 * The old `env ?? baked` chain sanitized only the winner of the coalescing, so
 * a malformed env value beat a valid baked one and then sanitized away to
 * undefined — blanking the field instead of falling through.
 */
test("resolveBrokerBuildInfo does not let an unsanitizable host env value erase baked provenance", () => {
  withBakedBuildInfo(BAKED, (file) => {
    withEnv({
      A2A_BROKER_VERSION: undefined,
      A2A_BROKER_REVISION: undefined,
      BROKER_RELEASE_REVISION: undefined,
      RELEASE_REVISION: undefined,
      A2A_BROKER_SOURCE: "https://credential.example.invalid/private/repo.git",
      A2A_BROKER_BUILT_AT: "invalid-timestamp-with-secret",
      A2A_BROKER_RUNTIME: undefined,
      A2A_BROKER_IMAGE_TAG: "private.registry.local/team/image:tag with secret",
      A2A_BROKER_IMAGE_DIGEST: undefined,
    }, () => {
      const resolved = resolveBrokerBuildInfo({ buildInfoFile: file }, "a2a-broker");

      assert.equal(resolved.build.builtAt, "2026-06-16T10:00:00Z");
      assert.equal(resolved.build.image?.tag, "a2a-broker:generated123");
      assert.equal(resolved.build.source, "github.com/jinwon-int/a2a-nexus");

      // Unsanitizable overrides are still surfaced, with the value redacted.
      assert.deepEqual(
        resolved.provenanceConflicts.map((c) => [c.field, c.ignored]),
        [["builtAt", "redacted"], ["imageTag", "redacted"]],
      );
    });
  });
});

/** Explicit programmatic options remain caller intent and outrank both. */
test("resolveBrokerBuildInfo still honours an explicit buildRevision option", () => {
  withBakedBuildInfo(BAKED, (file) => {
    withEnv({ A2A_BROKER_REVISION: "envrev456", BROKER_RELEASE_REVISION: undefined, RELEASE_REVISION: undefined }, () => {
      const resolved = resolveBrokerBuildInfo({ buildInfoFile: file, buildRevision: "explicit789" }, "a2a-broker");
      assert.equal(resolved.build.revision, "explicit789");
    });
  });
});
