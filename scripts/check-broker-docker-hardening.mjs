#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "packages/broker/Dockerfile"), "utf8");
const compose = fs.readFileSync(path.join(repoRoot, "packages/broker/docker-compose.yml"), "utf8");

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
    assert.match(dockerfile, /COPY\s+tsconfig\.base\.json\s+\/app\/tsconfig\.base\.json/);
    assert.match(dockerfile, /COPY\s+packages\/broker\/tsconfig\.json\s+\.\//);
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

  return { ok: true, checked: checks.length, checks };
}

try {
  console.log(JSON.stringify(check(), null, 2));
} catch (error) {
  console.error("broker Docker hardening check failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
