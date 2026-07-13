/**
 * Tests for the docker-runner extra-mounts preflight (a2a-nexus#775).
 *
 * Covers:
 * - Happy path: no extra mounts, and profile-correct mounts, are ready.
 * - Hermes profile with extra mounts but no /run/secrets/hermes-dir → BLOCK.
 * - OpenClaw profile missing its /run/secrets/openclaw-dir mount → BLOCK.
 * - Conflicting profile mount source → BLOCK.
 * - Forbidden writable runtime/session mount → BLOCK.
 * - Malformed JSON / malformed entry → BLOCK.
 * - Block reasons stay bounded and secret-free.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { evaluateExtraMountsPreflight } from "./extra-mounts-preflight.js";

test("ready when no extra mounts are configured", () => {
  const outcome = evaluateExtraMountsPreflight({});
  assert.equal(outcome.ok, true);
  assert.equal(outcome.failureCategory, "ok");
  assert.equal(outcome.profile, "none");
  assert.equal(outcome.blockReason, "");
});

test("ready when hermes profile includes the required hermes-dir mount", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/root/.hermes", target: "/run/secrets/hermes-dir", readOnly: true },
    ]),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.profile, "hermes");
  assert.equal(outcome.failureCategory, "ok");
});

test("ready when claude-code profile includes the required claude-dir mount", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "claude-code",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/root/.claude", target: "/run/secrets/claude-dir", readOnly: true },
    ]),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.profile, "claude-code");
  assert.equal(outcome.failureCategory, "ok");
});

test("blocks claude-code profile when the claude-dir mount is missing", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "cccb",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/var/tmp/a2a", target: "/scratch", readOnly: false },
    ]),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.profile, "claude-code");
  assert.equal(outcome.failureCategory, "claude_code_profile_mount_missing");
  assert.match(outcome.blockReason, /claude-code patch profile requires a \/run\/secrets\/claude-dir mount/);
});

test("ready when codex profile includes the required codex-dir mount", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "codex",
    A2A_DOCKER_RUNNER_CODEX_CONFIG_DIR: "/srv/codex-profile",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/srv/codex-profile", target: "/run/secrets/codex-dir", readOnly: true },
    ]),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.profile, "codex");
});

test("blocks codex profile when the codex-dir mount is missing", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "codex",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/tmp/scratch", target: "/work/scratch", readOnly: false },
    ]),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failureCategory, "codex_profile_mount_missing");
  assert.match(outcome.blockReason, /codex patch profile requires a \/run\/secrets\/codex-dir mount/);
});

test("blocks hermes profile when the hermes-dir mount is missing (the #775 incident)", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/var/tmp/a2a", target: "/scratch", readOnly: false },
    ]),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.profile, "hermes");
  assert.equal(outcome.failureCategory, "hermes_profile_mount_missing");
  assert.match(outcome.blockReason, /hermes patch profile requires a \/run\/secrets\/hermes-dir mount/);
});

test("blocks openclaw profile when the openclaw-dir mount is missing", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/usr/lib/node_modules/openclaw", target: "/usr/lib/node_modules/openclaw", readOnly: true },
    ]),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.profile, "openclaw");
  assert.equal(outcome.failureCategory, "openclaw_profile_mount_missing");
});

test("blocks a conflicting profile mount source", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR: "/root/.openclaw-a2a-deepseek-config",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/root/.openclaw", target: "/run/secrets/openclaw-dir", readOnly: true },
    ]),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failureCategory, "profile_mount_source_conflict");
});

test("blocks a forbidden writable agent runtime/session mount", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/root/.hermes/sessions", target: "/host-hermes-sessions", readOnly: false },
    ]),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failureCategory, "forbidden_writable_runtime_mount");
});

test("blocks a forbidden writable claude runtime/session mount", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/root/.claude", target: "/run/secrets/claude-dir", readOnly: false },
    ]),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failureCategory, "forbidden_writable_runtime_mount");
});

test("blocks malformed extra-mounts JSON", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: "{ not valid json",
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failureCategory, "extra_mounts_json_invalid");
});

test("blocks a malformed extra-mount entry", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([{ source: "relative", target: "/x" }]),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failureCategory, "extra_mounts_entry_invalid");
});

test("block reason stays bounded and free of obvious secret markers", () => {
  const outcome = evaluateExtraMountsPreflight({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/var/tmp/a2a", target: "/scratch", readOnly: false },
    ]),
  });
  assert.ok(outcome.blockReason.length <= 400);
  assert.doesNotMatch(outcome.summary, /\n/);
});
