import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// pre-pr-bootstrap-guard – standalone script smoke tests
// ---------------------------------------------------------------------------

const GUARD_SCRIPT = join(import.meta.dirname ?? ".", "..", "scripts", "pre-pr-bootstrap-guard.mjs");

test("guard script passes on clean repo dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-clean-"));
  try {
    writeFileSync(join(dir, "README.md"), "# test");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "// code");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.schemaVersion, "a2a.runner.pre-pr-bootstrap-guard.v1");
    assert.equal(output.parent, "a2a-broker#446");
    assert.equal(output.repo, ".");
    assert.equal(output.repoDir, undefined);
    assert.ok(!result.stdout.includes(dir), "guard evidence must not leak host-specific repo paths");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script ignores untracked bootstrap paths when gitignore excludes them", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-ignored-"));
  try {
    spawnSync("git", ["init"], { cwd: dir, encoding: "utf8", timeout: 5000 });
    writeFileSync(join(dir, ".gitignore"), "AGENTS.md\n.openclaw/\n");
    writeFileSync(join(dir, "AGENTS.md"), "# ignored agent context");
    mkdirSync(join(dir, ".openclaw"), { recursive: true });
    writeFileSync(join(dir, ".openclaw", "workspace-state.json"), "{}");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 0, `Expected exit 0 for ignored untracked paths, got ${result.status}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.offendingPaths, undefined);
    assert.ok(!result.stdout.includes(dir), "guard evidence must not leak host-specific repo paths");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks ignored bootstrap paths once they are staged", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-staged-"));
  try {
    spawnSync("git", ["init"], { cwd: dir, encoding: "utf8", timeout: 5000 });
    writeFileSync(join(dir, ".gitignore"), "AGENTS.md\n");
    writeFileSync(join(dir, "AGENTS.md"), "# staged agent context");
    const add = spawnSync("git", ["add", "-f", "AGENTS.md"], { cwd: dir, encoding: "utf8", timeout: 5000 });
    assert.equal(add.status, 0, add.stderr);

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1, `Expected exit 1, got ${result.status}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("AGENTS.md"), `Expected AGENTS.md in offending paths, got: ${JSON.stringify(output.offendingPaths)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on AGENTS.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-agents-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# agent context");
    writeFileSync(join(dir, "README.md"), "# test");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1, `Expected exit 1, got ${result.status}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("AGENTS.md"), `Expected AGENTS.md in offending paths, got: ${JSON.stringify(output.offendingPaths)}`);
    assert.ok(!result.stdout.includes(dir), "guard evidence must report only repo-relative offending paths");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on SOUL.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-soul-"));
  try {
    writeFileSync(join(dir, "SOUL.md"), "# soul");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("SOUL.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on USER.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-user-"));
  try {
    writeFileSync(join(dir, "USER.md"), "# user");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("USER.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on TOOLS.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-tools-"));
  try {
    writeFileSync(join(dir, "TOOLS.md"), "# tools");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("TOOLS.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on HEARTBEAT.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-heartbeat-"));
  try {
    writeFileSync(join(dir, "HEARTBEAT.md"), "# heartbeat");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("HEARTBEAT.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on IDENTITY.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-identity-"));
  try {
    writeFileSync(join(dir, "IDENTITY.md"), "# identity");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("IDENTITY.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on .openclaw directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-openclaw-"));
  try {
    mkdirSync(join(dir, ".openclaw"), { recursive: true });
    writeFileSync(join(dir, ".openclaw", "config.json"), "{}");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.some((p: string) => p.startsWith(".openclaw")), `Expected .openclaw in offending paths, got: ${JSON.stringify(output.offendingPaths)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on MEMORY.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-memory-md-"));
  try {
    writeFileSync(join(dir, "MEMORY.md"), "# memory");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("MEMORY.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks on memory directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-memory-dir-"));
  try {
    mkdirSync(join(dir, "memory"), { recursive: true });
    writeFileSync(join(dir, "memory", "2026-01-01.md"), "notes");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.some((p: string) => p.startsWith("memory/")), `Expected memory/ in offending paths, got: ${JSON.stringify(output.offendingPaths)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script reports all banned files at once", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-multi-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# agents");
    writeFileSync(join(dir, "SOUL.md"), "# soul");
    writeFileSync(join(dir, "IDENTITY.md"), "# identity");
    mkdirSync(join(dir, ".openclaw"), { recursive: true });
    writeFileSync(join(dir, ".openclaw", "state.json"), "{}");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("AGENTS.md"));
    assert.ok(output.offendingPaths.includes("SOUL.md"));
    assert.ok(output.offendingPaths.includes("IDENTITY.md"));
    assert.ok(output.offendingPaths.some((p: string) => p.startsWith(".openclaw")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks bootstrap files copied into artifact evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-artifact-repo-"));
  const artifacts = mkdtempSync(join(tmpdir(), "guard-artifact-evidence-"));
  try {
    writeFileSync(join(dir, "README.md"), "# clean repo");
    writeFileSync(join(artifacts, "AGENTS.md"), "# copied runtime context");
    mkdirSync(join(artifacts, ".openclaw"), { recursive: true });
    writeFileSync(join(artifacts, ".openclaw", "state.json"), "{}");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir, "--artifacts-dir", artifacts], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("artifacts/AGENTS.md"), JSON.stringify(output.offendingPaths));
    assert.ok(output.offendingPaths.includes("artifacts/.openclaw/state.json"), JSON.stringify(output.offendingPaths));
    assert.ok(!result.stdout.includes(dir), "guard evidence must not leak host-specific repo paths");
    assert.ok(!result.stdout.includes(artifacts), "guard evidence must not leak host-specific artifact paths");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// a2a-nexus#2221 – tracked bootstrap files identical to base are repository
// artifacts, not leaks; changed/new bootstrap files stay blocked.
// ---------------------------------------------------------------------------

function initRepoWithTrackedAgentsMd(dir: string): void {
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8", timeout: 5000 });
  spawnSync("git", ["config", "user.email", "guard-test@example.com"], { cwd: dir, encoding: "utf8", timeout: 5000 });
  spawnSync("git", ["config", "user.name", "guard-test"], { cwd: dir, encoding: "utf8", timeout: 5000 });
  writeFileSync(join(dir, "AGENTS.md"), "# tracked repository agent contract\n");
  writeFileSync(join(dir, "README.md"), "# test");
  const add = spawnSync("git", ["add", "."], { cwd: dir, encoding: "utf8", timeout: 5000 });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8", timeout: 5000 });
  assert.equal(commit.status, 0, commit.stderr);
}

test("guard script passes a tracked bootstrap file identical to the base branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-tracked-base-clean-"));
  try {
    initRepoWithTrackedAgentsMd(dir);

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 0, `Expected exit 0 for base-identical tracked AGENTS.md, got ${result.status}: ${result.stderr}${result.stdout}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.offendingPaths, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks a tracked bootstrap file modified in the worktree against base", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-tracked-base-dirty-"));
  try {
    initRepoWithTrackedAgentsMd(dir);
    writeFileSync(join(dir, "AGENTS.md"), "# tracked repository agent contract\n# agent-local drift\n");

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1, `Expected exit 1 for worktree-modified tracked AGENTS.md, got ${result.status}: ${result.stdout}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("AGENTS.md"), JSON.stringify(output.offendingPaths));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script blocks a tracked bootstrap file committed ahead of base", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-tracked-base-committed-"));
  try {
    initRepoWithTrackedAgentsMd(dir);
    // Mirror the runner flow: the patch branch is created from base and the
    // drift commit lands on the patch branch, so base stays behind.
    const branch = spawnSync("git", ["checkout", "-b", "a2a-patch-branch"], { cwd: dir, encoding: "utf8", timeout: 5000 });
    assert.equal(branch.status, 0, branch.stderr);
    writeFileSync(join(dir, "AGENTS.md"), "# tracked repository agent contract\n# committed drift\n");
    spawnSync("git", ["add", "AGENTS.md"], { cwd: dir, encoding: "utf8", timeout: 5000 });
    const commit = spawnSync("git", ["commit", "-m", "drift"], { cwd: dir, encoding: "utf8", timeout: 5000 });
    assert.equal(commit.status, 0, commit.stderr);

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir, "--base-branch", "main"], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1, `Expected exit 1 for committed tracked AGENTS.md drift, got ${result.status}: ${result.stdout}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("AGENTS.md"), JSON.stringify(output.offendingPaths));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script fails closed for tracked bootstrap files when the base branch is unresolvable", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-tracked-no-base-"));
  try {
    initRepoWithTrackedAgentsMd(dir);

    const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", dir, "--base-branch", "does-not-exist"], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1, `Expected exit 1 when base ref cannot be resolved, got ${result.status}: ${result.stdout}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.offendingPaths.includes("AGENTS.md"), JSON.stringify(output.offendingPaths));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard script exits 2 on missing repo-dir", () => {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT], {
    encoding: "utf8",
    timeout: 5000,
  });

  assert.equal(result.status, 2);
});

test("guard script exits 2 on unknown argument", () => {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--unknown"], {
    encoding: "utf8",
    timeout: 5000,
  });

  assert.equal(result.status, 2);
});

test("guard script --help exits 0", () => {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT, "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });

  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("--repo-dir"));
});
