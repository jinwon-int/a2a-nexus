import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "packages/broker/Dockerfile"), "utf8");
const compose = fs.readFileSync(path.join(repoRoot, "packages/broker/docker-compose.yml"), "utf8");

test("broker Dockerfile requires production provenance and canonical a2a-nexus source", () => {
  assert.match(dockerfile, /A2A_BROKER_IMAGE_SOURCE=https:\/\/github\.com\/jinwon-int\/a2a-nexus/);
  assert.match(dockerfile, /A2A_BROKER_SOURCE=github\.com\/jinwon-int\/a2a-nexus/);
  assert.doesNotMatch(dockerfile, /ARG\s+A2A_BROKER_REVISION=unknown/);
  assert.match(dockerfile, /test\s+"\$A2A_BROKER_REVISION"\s+!=\s+"unknown"/);
  assert.match(dockerfile, /test\s+-n\s+"\$A2A_BROKER_CREATED"/);
});

test("broker Docker runtime runs non-root with writable state path prepared", () => {
  assert.match(dockerfile, /mkdir\s+-p\s+\/var\/lib\/a2a-broker/);
  assert.match(dockerfile, /chown\s+-R\s+node:node\s+\/app\s+\/var\/lib\/a2a-broker/);
  assert.match(dockerfile, /^USER\s+node$/m);
});

test("broker Dockerfile installs every handler transitive support module", () => {
  assert.match(
    dockerfile,
    /cp packages\/broker\/scripts\/lib\/source-carriers\.mjs \.\/handlers\/lib\/source-carriers\.mjs/,
  );
  assert.match(
    dockerfile,
    /cp packages\/broker\/scripts\/lib\/retrieval-snapshot-carriers\.mjs \.\/handlers\/lib\/retrieval-snapshot-carriers\.mjs/,
  );
  assert.match(
    dockerfile,
    /cp packages\/broker\/scripts\/lib\/live-operation-adapter\.mjs \.\/handlers\/lib\/live-operation-adapter\.mjs/,
  );
});

test("broker compose build args fail closed instead of falling back to unknown or empty provenance", () => {
  assert.match(compose, /A2A_BROKER_REVISION:\s+\$\{A2A_BROKER_REVISION:\?[^}]+\}/);
  assert.match(compose, /A2A_BROKER_CREATED:\s+\$\{A2A_BROKER_CREATED:\?[^}]+\}/);
  assert.doesNotMatch(compose, /A2A_BROKER_REVISION:\s+\$\{A2A_BROKER_REVISION:-unknown\}/);
  assert.doesNotMatch(compose, /A2A_BROKER_CREATED:\s+\$\{A2A_BROKER_CREATED:-\}/);
  assert.match(compose, /\$\{A2A_BROKER_STATE_DIR:-\/var\/lib\/a2a-broker\}:\/var\/lib\/a2a-broker/);
});
