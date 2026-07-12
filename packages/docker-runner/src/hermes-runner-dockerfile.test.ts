import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../docker/hermes-runner.Dockerfile", import.meta.url), "utf8");
const claudeCodeDockerfile = readFileSync(new URL("../docker/claude-code-runner.Dockerfile", import.meta.url), "utf8");

test("Hermes runner image pins the current GPT-5.6-capable Hermes release", () => {
  assert.match(
    dockerfile,
    /ARG HERMES_REF=9de9c25f620ff7f1ce0fd5457d596052d5159596/,
  );
  assert.match(dockerfile, /org\.openclaw\.a2a-docker-runner\.hermes\.ref="\$\{HERMES_REF\}"/);
});

test("Hermes runner image bakes in an external secret scanner for release-gate tasks (#780)", () => {
  assert.match(dockerfile, /ARG GITLEAKS_VERSION=\d+\.\d+\.\d+/);
  assert.match(dockerfile, /gitleaks_\$\{GITLEAKS_VERSION\}_linux_\$\{gitleaks_arch\}\.tar\.gz/);
  assert.match(dockerfile, /install -m 0755 \/tmp\/gitleaks \/usr\/bin\/gitleaks/);
  assert.match(dockerfile, /gitleaks version/);
});

test("Claude Code cccb runner image bakes required patch bridge and tools (#1030)", () => {
  assert.match(claudeCodeDockerfile, /ARG CLAUDE_CODE_PACKAGE=@anthropic-ai\/claude-code/);
  assert.match(claudeCodeDockerfile, /npm install -g "\$\{CLAUDE_CODE_PACKAGE\}"/);
  assert.match(claudeCodeDockerfile, /claude --version/);
  assert.match(claudeCodeDockerfile, /gh_\$\{GH_VERSION\}_linux_\$\{gh_arch\}\.tar\.gz/);
  assert.match(claudeCodeDockerfile, /gitleaks_\$\{GITLEAKS_VERSION\}_linux_\$\{gitleaks_arch\}\.tar\.gz/);
  assert.match(claudeCodeDockerfile, /claude-a2a-patch-bridge\.mjs/);
  assert.match(claudeCodeDockerfile, /\/opt\/a2a-broker\/scripts\/claude-a2a-patch-bridge\.mjs/);
  assert.match(claudeCodeDockerfile, /org\.openclaw\.a2a-docker-runner\.harness="claude-code"/);
});

test("Claude Code cccb runner image keeps credentials runtime-mounted only (#1030)", () => {
  assert.doesNotMatch(claudeCodeDockerfile, /COPY\s+.*\.claude/i);
  assert.doesNotMatch(claudeCodeDockerfile, /ADD\s+.*\.claude/i);
  assert.doesNotMatch(claudeCodeDockerfile, /A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR\s*=/);
  assert.match(claudeCodeDockerfile, /credentials are mounted at runtime/i);
});
