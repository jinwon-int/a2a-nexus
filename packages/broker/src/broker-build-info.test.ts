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

test("resolveBrokerBuildInfo preserves health build metadata semantics", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-build-info-resolve-"));
  try {
    const file = join(dir, "build-info.json");
    writeFileSync(file, JSON.stringify({
      version: "9.9.9",
      revision: "generated123",
      source: "github.com/jinwon-int/a2a-nexus",
      builtAt: "2026-06-16T10:00:00Z",
      runtime: "docker",
      image: { tag: "a2a-broker:generated123", digest: "sha256:" + "a".repeat(64) },
    }));

    withEnv({
      A2A_BROKER_VERSION: undefined,
      A2A_BROKER_REVISION: "envrev456",
      BROKER_RELEASE_REVISION: undefined,
      RELEASE_REVISION: undefined,
      A2A_BROKER_SOURCE: "https://credential.example.invalid/private/repo.git",
      A2A_BROKER_BUILT_AT: "invalid-timestamp-with-secret",
      A2A_BROKER_RUNTIME: "docker",
      A2A_BROKER_IMAGE_TAG: "private.registry.local/team/image:tag with secret",
      A2A_BROKER_IMAGE_DIGEST: "sha256:" + "b".repeat(64),
    }, () => {
      assert.deepEqual(resolveBrokerBuildInfo({ buildInfoFile: file }, "a2a-broker"), {
        version: "9.9.9",
        build: {
          component: "a2a-broker",
          revision: "envrev456",
          source: "github.com/jinwon-int/a2a-nexus",
          runtime: "docker",
          image: { digest: "sha256:" + "b".repeat(64) },
        },
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
