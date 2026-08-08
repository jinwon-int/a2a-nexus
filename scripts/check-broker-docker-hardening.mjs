#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "packages/broker/Dockerfile"), "utf8");
const compose = fs.readFileSync(path.join(repoRoot, "packages/broker/docker-compose.yml"), "utf8");
const brokerPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages/broker/package.json"), "utf8"));

function check() {
  const checks = [];
  function ok(name, fn) {
    fn();
    checks.push(name);
  }

  ok("canonical OCI/source labels point to a2a-nexus", () => {
    assert.match(dockerfile, /A2A_BROKER_IMAGE_SOURCE=https:\/\/github\.com\/jinwon-int\/a2a-nexus/);
    assert.match(dockerfile, /A2A_BROKER_SOURCE=github\.com\/jinwon-int\/a2a-nexus/);
  });
  ok("Dockerfile provenance fails closed", () => {
    assert.doesNotMatch(dockerfile, /ARG\s+A2A_BROKER_REVISION=unknown/);
    assert.match(dockerfile, /test\s+"\$A2A_BROKER_REVISION"\s+!=\s+"unknown"/);
    assert.match(dockerfile, /test\s+-n\s+"\$A2A_BROKER_CREATED"/);
  });
  ok("runtime is non-root and state path is owned by node", () => {
    assert.match(dockerfile, /mkdir\s+-p\s+\/var\/lib\/a2a-broker\s+\.\/handlers/);
    assert.match(dockerfile, /chown\s+-R\s+node:node\s+\/app\s+\/var\/lib\/a2a-broker/);
    assert.match(dockerfile, /^USER\s+node$/m);
  });
  ok("compose builds broker image from repo-root context so shared tsconfig is available", () => {
    assert.match(compose, /context:\s+\.\.\/\.\./);
    assert.match(compose, /dockerfile:\s+packages\/broker\/Dockerfile/);
    assert.match(dockerfile, /COPY\s+tsconfig\.base\.json\s+\.\/tsconfig\.base\.json/);
    assert.match(dockerfile, /COPY\s+packages\/broker\/tsconfig\.json\s+packages\/broker\//);
    // #1601 P1/P2: the broker image is workspace-aware — in-repo package
    // dependencies must be installed and built alongside the broker.
    assert.match(dockerfile, /COPY\s+packages\/policy-referee\/src\s+packages\/policy-referee\/src/);
    assert.match(dockerfile, /COPY\s+packages\/attestation\/src\s+packages\/attestation\/src/);
  });
  ok("compose build args require revision and created timestamp", () => {
    assert.match(compose, /A2A_BROKER_REVISION:\s+\$\{A2A_BROKER_REVISION:\?[^}]+\}/);
    assert.match(compose, /A2A_BROKER_CREATED:\s+\$\{A2A_BROKER_CREATED:\?[^}]+\}/);
    assert.doesNotMatch(compose, /A2A_BROKER_REVISION:\s+\$\{A2A_BROKER_REVISION:-unknown\}/);
    assert.doesNotMatch(compose, /A2A_BROKER_CREATED:\s+\$\{A2A_BROKER_CREATED:-\}/);
  });
  ok("compose state volume is overrideable for non-root writable host paths", () => {
    assert.match(compose, /\$\{A2A_BROKER_STATE_DIR:-\/var\/lib\/a2a-broker\}:\/var\/lib\/a2a-broker/);
  });
  // #1766: the revision label used to be asserted non-empty but never checked
  // against the source being built, so a stale shell export shipped as
  // production provenance. Freeze the wiring that closes that gap — removing
  // any leg of it silently restores the original defect.
  ok("build revision preflight stays wired into the build entrypoints", () => {
    assert.match(brokerPkg.scripts?.build ?? "", /check-build-revision\.mjs/);
    assert.match(brokerPkg.scripts?.["build:image"] ?? "", /check-build-revision\.mjs\s+--docker-build/);
    // Once per stage: the build stage (generate-build-info imports it) and the
    // runtime stage (which regenerates build-info from the ARGs).
    assert.equal((dockerfile.match(/COPY packages\/broker\/scripts\/check-build-revision\.mjs/g) ?? []).length, 2);
  });
  ok("image records whether its revision was verified against the built tree", () => {
    assert.match(dockerfile, /ARG\s+A2A_BROKER_REVISION_VERIFIED=false/);
    assert.match(dockerfile, /dev\.a2a\.image\.revision-verified=\$A2A_BROKER_REVISION_VERIFIED/);
    assert.match(compose, /A2A_BROKER_REVISION_VERIFIED:\s+\$\{A2A_BROKER_REVISION_VERIFIED:-false\}/);
    // A revision that is not a git SHA cannot be checked against a tree.
    assert.match(dockerfile, /grep\s+-Eq\s+'\^\[0-9a-f\]\{7,40\}\(-dirty\)\?\$'/);
  });

  return { ok: true, checked: checks.length, checks };
}

try {
  console.log(JSON.stringify(check(), null, 2));
} catch (error) {
  console.error("broker Docker hardening check failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
