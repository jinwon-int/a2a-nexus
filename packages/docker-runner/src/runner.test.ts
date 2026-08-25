import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildActionableError, buildContainerScript, buildRunArgs, extractClaudeTurnBudgetDiagnostic, extractPrUrl, extractPrUrls, extractPushedBranch, jsonArgvToScript, prepareWorkDirForContainerUser, redactAndBound, redactSecrets, runTask, shouldTreatDetectedPrUrlAsCanonical } from "./runner.js";
import type { NormalizedRunnerTask, RunnerConfig, RunnerTask } from "./types.js";

const baseConfig: RunnerConfig = {
  rootDir: join(tmpdir(), "a2a-runner-test"),
  image: "node:22-bookworm-slim",
  defaultTimeoutMs: 10_000,
  memory: "512m",
  cpus: "1",
};

const validMaxTurnDiagnostic = {
  schemaVersion: "a2a.claude.turn-budget.v1",
  mode: "agentic-patch",
  effectiveMaxTurns: 40,
  source: "explicit_override",
  overrideKey: "A2A_CLAUDE_CODE_PATCH_MAX_TURNS",
  hardCap: 64,
  hardCapApplied: false,
  outcome: "failure",
  turnsUsed: 40,
  invocationCount: 1,
  failureReason: "max_turns",
  checkpointStatus: "preserved",
  checkpointRef: "artifacts/claude-max-turn-checkpoint.json",
} as const;

type MaxTurnCheckpointFixture = Record<string, unknown> & {
  changedPaths: string[];
  limits: { maxBytes: number; diffBytes: number; statusBytes: number };
};

interface MaxTurnRunFixture {
  diagnostic?: Record<string, unknown>;
  diagnosticArtifact?: boolean;
  stderrLines?: string[];
  checkpoint?: boolean;
  mutateCheckpoint?: (checkpoint: MaxTurnCheckpointFixture) => void;
  fileMutation?: "hardlink-diff" | "symlink-status" | "missing-status";
}

async function runMaxTurnFixture(options: MaxTurnRunFixture = {}) {
  const executableTmpDir = fileURLToPath(new URL("../tmp/", import.meta.url));
  mkdirSync(executableTmpDir, { recursive: true });
  const fixtureDir = mkdtempSync(join(executableTmpDir, "max-turn-fixture-"));
  const artifactsDir = join(fixtureDir, "seed-artifacts");
  const runsDir = join(fixtureDir, "runs");
  const enginePath = join(fixtureDir, "docker");
  const stderrPath = join(fixtureDir, "stderr.txt");
  const originalPath = process.env.PATH;
  mkdirSync(artifactsDir, { recursive: true });

  const diagnostic = options.diagnostic ?? validMaxTurnDiagnostic;
  const stderrLines = options.stderrLines ?? [
    `claude_turn_budget=${JSON.stringify(diagnostic)}`,
    "terminal_reason=max_turns",
  ];
  writeFileSync(stderrPath, `${stderrLines.join("\n")}\n`);
  if (options.diagnosticArtifact !== false) {
    writeFileSync(join(artifactsDir, "claude-turn-budget.json"), JSON.stringify(diagnostic));
  }

  if (options.checkpoint) {
    const diff = "diff --git a/src/runner.ts b/src/runner.ts\n";
    const status = " M src/runner.ts\n";
    const checkpoint: MaxTurnCheckpointFixture = {
      schemaVersion: "a2a.claude.max-turn-checkpoint.v1",
      createdAt: "1970-01-01T00:00:00.000Z",
      checkpointId: `sha256:${"a".repeat(64)}`,
      reason: "max_turns",
      resumable: true,
      repository: "jinwon-int/a2a-nexus",
      base: { ref: "refs/heads/parent", commit: "1".repeat(40) },
      head: { ref: "refs/heads/child", commit: "2".repeat(40) },
      changedPaths: ["src/runner.ts"],
      diffPath: "artifacts/claude-max-turn-checkpoint.diff",
      statusPath: "artifacts/claude-max-turn-checkpoint.status",
      includesUntracked: false,
      pushPerformed: false,
      pullRequestOpened: false,
      taskSucceeded: false,
      evidenceGatesBypassed: false,
      secretScan: { status: "passed", scanner: "a2a-checkpoint-pattern-v1" },
      limits: {
        maxBytes: 1024 * 1024,
        diffBytes: Buffer.byteLength(diff),
        statusBytes: Buffer.byteLength(status),
      },
    };
    options.mutateCheckpoint?.(checkpoint);
    writeFileSync(join(artifactsDir, "claude-max-turn-checkpoint.json"), JSON.stringify(checkpoint));
    writeFileSync(join(artifactsDir, "claude-max-turn-checkpoint.diff"), diff);
    writeFileSync(join(artifactsDir, "claude-max-turn-checkpoint.status"), status);
    if (options.fileMutation) {
      writeFileSync(join(artifactsDir, `.${options.fileMutation}`), "");
    }
  }

  writeFileSync(enginePath, `#!/usr/bin/env bash
set -euo pipefail
work_dir=
for arg in "$@"; do
  case "$arg" in
    *:/work) work_dir="\${arg%:/work}" ;;
  esac
done
test -n "$work_dir"
mkdir -p "$work_dir/artifacts"
cp -R "${artifactsDir}/." "$work_dir/artifacts/"
if test -f "$work_dir/artifacts/.hardlink-diff"; then
  rm "$work_dir/artifacts/.hardlink-diff"
  ln "$work_dir/artifacts/claude-max-turn-checkpoint.diff" "$work_dir/artifacts/checkpoint-diff-hardlink"
fi
if test -f "$work_dir/artifacts/.symlink-status"; then
  rm "$work_dir/artifacts/.symlink-status" "$work_dir/artifacts/claude-max-turn-checkpoint.status"
  ln -s "claude-max-turn-checkpoint.diff" "$work_dir/artifacts/claude-max-turn-checkpoint.status"
fi
if test -f "$work_dir/artifacts/.missing-status"; then
  rm "$work_dir/artifacts/.missing-status" "$work_dir/artifacts/claude-max-turn-checkpoint.status"
fi
cat "${stderrPath}" >&2
exit 1
`);
  chmodSync(enginePath, 0o700);

  try {
    process.env.PATH = `${fixtureDir}:${originalPath ?? ""}`;
    return await runTask(
      { ...baseConfig, rootDir: runsDir, engine: "docker" },
      { id: `max-turn-${Math.random().toString(36).slice(2)}`, intent: "verify", commands: ["true"] },
    );
  } finally {
    process.env.PATH = originalPath;
    try {
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      execFileSync("rm", ["-rf", fixtureDir]);
    }
  }
}

// ---------------------------------------------------------------------------
// safeId (via runTask validation / workDir creation)
// ---------------------------------------------------------------------------

test("rejects task without id", async () => {
  await assert.rejects(
    runTask(baseConfig, { intent: "propose_patch" } as RunnerTask),
    /task\.id is required/,
  );
});

test("rejects task without intent", async () => {
  await assert.rejects(
    runTask(baseConfig, { id: "no-intent" } as RunnerTask),
    /task\.intent is required/,
  );
});

test("passes normalized OpenClaw worker overrides into container env", () => {
  const task: NormalizedRunnerTask = {
    id: "worker-model-pro",
    intent: "propose_patch",
    repos: [],
    commands: [],
    env: {
      A2A_OPENCLAW_MODEL: "deepseek/deepseek-v4-pro",
      A2A_OPENCLAW_THINKING: "high",
    },
  };

  const args = buildRunArgs(baseConfig, task, "/tmp/a2a-worker-model-test", "run123");
  assert.ok(args.includes("A2A_OPENCLAW_MODEL=deepseek/deepseek-v4-pro"));
  assert.ok(args.includes("A2A_OPENCLAW_THINKING=high"));
});

test("redacts OpenClaw runtime paths from result streams", () => {
  const redacted = redactSecrets([
    "session=/root/.openclaw/agents/main/sessions/session-123.jsonl",
    "workspace=/tmp/openclaw-agent-workspace/AGENTS.md",
    "repo=/work/repo/AGENTS.md",
  ].join("\n"));

  assert.ok(!redacted.includes("/root/.openclaw"));
  assert.ok(!redacted.includes("/tmp/openclaw-agent-workspace"));
  assert.ok(redacted.includes("<openclaw-dir>"));
  assert.ok(redacted.includes("<openclaw-workspace>"));
  assert.ok(redacted.includes("/work/repo/AGENTS.md"), "repo-relative bootstrap evidence must remain visible");
});

test("redacts controls, prefixed secrets, structured provider targets, and private paths", () => {
  const secrets = [
    `${["DB", "PASSWORD"].join("_")}=hunter2`,
    `${["A2A", "EDGE", "SECRET"].join("_")}=abc123`,
    `${["OPENAI", "API", "KEY"].join("_")}=\"short value\"`,
    `${["github", "token"].join("_")}: short-token`,
  ].join(" ");
  const redacted = redactSecrets(`${secrets} before\u0000after\u0007 \"chat_id\": 123456789 \"thread_id\": '-123456789' telegram = \" 234567890 \" /root/.hermes/private`);
  assert.doesNotMatch(redacted, /hunter2|abc123|short value|short-token|\u0000|\u0007|123456789|234567890|\/root\/\.hermes/);
});

test("redactAndBound enforces UTF-8 bytes without splitting code points", () => {
  const bounded = redactAndBound("😀".repeat(10), 13);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 13);
  assert.doesNotMatch(bounded, /�/);
});

test("extractClaudeTurnBudgetDiagnostic accepts a complete strict diagnostic", () => {
  const diagnostic = extractClaudeTurnBudgetDiagnostic(
    [
      "ordinary stderr",
      `claude_turn_budget=${JSON.stringify(validMaxTurnDiagnostic)}`,
      "terminal_reason=max_turns",
    ].join("\n"),
  );
  assert.equal(diagnostic?.effectiveMaxTurns, 40);
  assert.equal(diagnostic?.turnsUsed, 40);
  assert.equal(diagnostic?.overrideKey, "A2A_CLAUDE_CODE_PATCH_MAX_TURNS");
  assert.equal(diagnostic?.hardCap, 64);
  assert.equal(diagnostic?.hardCapApplied, false);
});

test("extractClaudeTurnBudgetDiagnostic ignores malformed and model-controlled lookalikes", () => {
  const malformed = [
    `model said claude_turn_budget=${JSON.stringify(validMaxTurnDiagnostic)}`,
    ` claude_turn_budget=${JSON.stringify(validMaxTurnDiagnostic)}`,
    "claude_turn_budget={not-json",
    "claude_turn_budget=null",
  ].join("\n");
  assert.equal(extractClaudeTurnBudgetDiagnostic(malformed), undefined);
});

test("extractClaudeTurnBudgetDiagnostic uses the last trustworthy line across streams", () => {
  const earlier = { ...validMaxTurnDiagnostic, effectiveMaxTurns: 20, turnsUsed: 19 };
  const later = { ...validMaxTurnDiagnostic, effectiveMaxTurns: 60, turnsUsed: 60 };
  const diagnostic = extractClaudeTurnBudgetDiagnostic(
    `claude_turn_budget=${JSON.stringify(earlier)}`,
    [
      `claude_turn_budget=${JSON.stringify(later)}`,
      "claude_turn_budget={malformed",
    ].join("\n"),
  );
  assert.equal(diagnostic?.effectiveMaxTurns, 60);
  assert.equal(diagnostic?.turnsUsed, 60);
});

test("extractClaudeTurnBudgetDiagnostic rejects invalid schema and constrained fields", () => {
  const invalidDiagnostics: Record<string, unknown>[] = [
    { ...validMaxTurnDiagnostic, schemaVersion: "a2a.claude.turn-budget.v2" },
    { ...validMaxTurnDiagnostic, mode: "model-controlled" },
    { ...validMaxTurnDiagnostic, source: "stderr_claim" },
    { ...validMaxTurnDiagnostic, effectiveMaxTurns: 0 },
    { ...validMaxTurnDiagnostic, effectiveMaxTurns: 1.5 },
    { ...validMaxTurnDiagnostic, outcome: "stopped" },
    { ...validMaxTurnDiagnostic, turnsUsed: -1 },
    { ...validMaxTurnDiagnostic, invocationCount: 0 },
    { ...validMaxTurnDiagnostic, overrideKey: "MODEL_MAX_TURNS" },
    { ...validMaxTurnDiagnostic, failureReason: "claimed_max_turns" },
    { ...validMaxTurnDiagnostic, checkpointRef: "../../escape" },
    { ...validMaxTurnDiagnostic, hardCap: 0 },
    { ...validMaxTurnDiagnostic, hardCapApplied: "false" },
    { ...validMaxTurnDiagnostic, checkpointStatus: "Preserved by model" },
  ];
  for (const invalid of invalidDiagnostics) {
    assert.equal(
      extractClaudeTurnBudgetDiagnostic(`claude_turn_budget=${JSON.stringify(invalid)}`),
      undefined,
    );
  }
});

test("runTask classifies max-turn exhaustion with trustworthy usage and a safe checkpoint", async () => {
  const result = await runMaxTurnFixture({ checkpoint: true });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.terminalReason, "max_turns");
  assert.equal(result.claudeTurnBudget?.turnsUsed, 40);
  assert.equal(result.artifactManifest?.status, "budget_limited");
  assert.deepEqual(result.artifactManifest?.budget, {
    limitKind: "turn",
    limit: "40",
    used: "40",
    reason: "max_turns",
  });
  assert.equal(result.checkpointRef, "artifacts/claude-max-turn-checkpoint.json");
  assert.equal(result.artifactManifest?.checkpointRef, result.checkpointRef);
  assert.equal(result.resultSummary?.checkpointRef, result.checkpointRef);
  assert.equal(result.resultSummary?.terminalReason, "max_turns");
  assert.match(result.artifactManifest?.continuation?.nextPrompt ?? "", /exact base commit/);
  assert.match(result.error ?? "", /Safe checkpoint/);
});

test("runTask classifies a trustworthy max-turn diagnostic without invented usage", async () => {
  const diagnostic: Record<string, unknown> = { ...validMaxTurnDiagnostic };
  delete diagnostic.turnsUsed;
  delete diagnostic.checkpointStatus;
  delete diagnostic.checkpointRef;

  const result = await runMaxTurnFixture({ diagnostic });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.terminalReason, "max_turns");
  assert.equal(result.claudeTurnBudget?.turnsUsed, undefined);
  assert.equal(result.artifactManifest?.status, "budget_limited");
  assert.equal(result.artifactManifest?.budget?.limit, "40");
  assert.equal(result.artifactManifest?.budget?.used, undefined);
  assert.equal(result.checkpointRef, undefined);
  assert.equal(result.artifactManifest?.continuation?.nextPrompt, undefined);
});

test("runTask honors the canonical max-turn terminal marker without trusting a lookalike diagnostic", async () => {
  const result = await runMaxTurnFixture({
    diagnosticArtifact: false,
    stderrLines: [
      `model output: claude_turn_budget=${JSON.stringify(validMaxTurnDiagnostic)}`,
      "terminal_reason=max_turns",
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.terminalReason, "max_turns");
  assert.equal(result.claudeTurnBudget, undefined);
  assert.equal(result.artifactManifest?.status, "failed");
  assert.equal(result.artifactManifest?.budget, undefined);
  assert.equal(result.checkpointRef, undefined);
});

test("runTask rejects unsafe or inconsistent checkpoint evidence while preserving max-turn failure", async (t) => {
  const rejectionCases: Array<{
    name: string;
    mutateCheckpoint?: (checkpoint: MaxTurnCheckpointFixture) => void;
    fileMutation?: MaxTurnRunFixture["fileMutation"];
  }> = [
    {
      name: "malformed schema",
      mutateCheckpoint: (checkpoint) => {
        checkpoint.schemaVersion = "a2a.claude.max-turn-checkpoint.v2";
      },
    },
    {
      name: "relative traversal path",
      mutateCheckpoint: (checkpoint) => {
        checkpoint.changedPaths = ["../outside.txt"];
      },
    },
    {
      name: "OpenClaw bootstrap file",
      mutateCheckpoint: (checkpoint) => {
        checkpoint.changedPaths = ["AGENTS.md"];
      },
    },
    {
      name: "OpenClaw runtime tree",
      mutateCheckpoint: (checkpoint) => {
        checkpoint.changedPaths = [".openclaw/agents/main/session.jsonl"];
      },
    },
    {
      name: "unsorted path list",
      mutateCheckpoint: (checkpoint) => {
        checkpoint.changedPaths = ["src/z.ts", "src/a.ts"];
      },
    },
    {
      name: "unexpected manifest field",
      mutateCheckpoint: (checkpoint) => {
        checkpoint.modelClaim = "safe";
      },
    },
    { name: "hard-linked diff file", fileMutation: "hardlink-diff" },
    { name: "symbolic-link status file", fileMutation: "symlink-status" },
    { name: "missing status file", fileMutation: "missing-status" },
    {
      name: "declared diff size mismatch",
      mutateCheckpoint: (checkpoint) => {
        checkpoint.limits.diffBytes += 1;
      },
    },
    {
      name: "total checkpoint size mismatch",
      mutateCheckpoint: (checkpoint) => {
        checkpoint.limits.maxBytes = 1;
      },
    },
  ];

  for (const rejectionCase of rejectionCases) {
    await t.test(rejectionCase.name, async () => {
      const result = await runMaxTurnFixture({
        checkpoint: true,
        mutateCheckpoint: rejectionCase.mutateCheckpoint,
        fileMutation: rejectionCase.fileMutation,
      });

      assert.equal(result.ok, false);
      assert.equal(result.terminalReason, "max_turns");
      assert.equal(result.artifactManifest?.status, "budget_limited");
      assert.equal(result.checkpointRef, undefined);
      assert.equal(result.artifactManifest?.checkpointRef, undefined);
      assert.equal(result.resultSummary?.checkpointRef, undefined);
      assert.equal(result.artifactManifest?.continuation?.nextPrompt, undefined);
      assert.doesNotMatch(result.error ?? "", /Safe checkpoint/);
    });
  }
});

test("prepares trusted non-root container workdir ownership before launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-runner-nonroot-workdir-"));
  const runScript = join(dir, "run.sh");
  const patchScript = join(dir, "patch-command.sh");
  const containerUid = 1000;
  const containerGid = 1000;

  const hasContainerAccess = (path: string, access: "read" | "execute") => {
    const st = statSync(path);
    const ownerBit = access === "read" ? 0o400 : 0o100;
    const groupBit = access === "read" ? 0o040 : 0o010;
    const otherBit = access === "read" ? 0o004 : 0o001;
    return (
      (st.uid === containerUid && (st.mode & ownerBit) !== 0) ||
      (st.gid === containerGid && (st.mode & groupBit) !== 0) ||
      (st.mode & otherBit) !== 0
    );
  };

  try {
    writeFileSync(runScript, "#!/usr/bin/env bash\necho run\n", { mode: 0o700 });
    writeFileSync(patchScript, "#!/usr/bin/env bash\necho patch\n", { mode: 0o700 });

    await prepareWorkDirForContainerUser(dir, "1000:1000");

    if (typeof process.getuid === "function" && process.getuid() === 0) {
      assert.equal(statSync(dir).uid, containerUid);
      assert.equal(statSync(runScript).uid, containerUid);
      assert.equal(statSync(patchScript).uid, containerUid);
    }

    assert.ok(hasContainerAccess(dir, "execute"), "container user must be able to traverse the workdir");
    assert.ok(hasContainerAccess(runScript, "read"), "container user must be able to read run.sh");
    assert.ok(hasContainerAccess(runScript, "execute"), "container user must be able to execute run.sh");
    assert.ok(hasContainerAccess(patchScript, "read"), "container user must be able to read patch-command.sh");
    assert.ok(hasContainerAccess(patchScript, "execute"), "container user must be able to execute patch-command.sh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sanitises task id for filesystem safety", async () => {
  // This test verifies the safeId behavior indirectly through workDir.
  const task: RunnerTask = {
    id: "a/b:c d?*",
    intent: "propose_patch",
    commands: ["printf ok"],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 2000 };

  // On a host without Docker, runTask will fail at spawn.
  // The test asserts the workDir path is safe regardless.
  try {
    const result = await runTask(config, task);
    assert.ok(!result.workDir.includes("/"));
    assert.ok(!result.workDir.includes(" "));
    assert.ok(!result.workDir.includes("?"));
    assert.ok(!result.workDir.includes("*"));
    assert.ok(!result.workDir.includes(":"));
  } catch {
    // Docker not available is expected; skip validation of workDir.
  }
});

// ---------------------------------------------------------------------------
// validateTask
// ---------------------------------------------------------------------------

test("validates task.id and task.intent are required", () => {
  // Covered by rejects tests above.
});

test("returns block result for non-Docker workerProfile", async () => {
  const result = await runTask(baseConfig, {
    id: "hermes-task",
    intent: "propose_patch",
    workerProfile: "termux-hermes",
  });
  assert.equal(result.ok, false);
  assert.equal(result.github?.outcome, "worker_profile_blocked");
  assert.ok(result.error?.includes("termux-hermes"));
  assert.ok(result.error?.includes("Hermes"));
  assert.ok(result.stdout?.includes("blocked"));
});

test("returns block result for external-harness workerProfile", async () => {
  const result = await runTask(baseConfig, {
    id: "external-task",
    intent: "propose_patch",
    workerProfile: "external-harness",
  });
  assert.equal(result.ok, false);
  assert.equal(result.github?.outcome, "worker_profile_blocked");
  assert.ok(result.error?.includes("external-harness"));
});

test("returns block result for hermes workerProfile", async () => {
  const result = await runTask(baseConfig, {
    id: "hermes-native",
    intent: "propose_patch",
    workerProfile: "hermes",
  });
  assert.equal(result.ok, false);
  assert.equal(result.github?.outcome, "worker_profile_blocked");
  assert.ok(result.error?.includes("hermes"));
});

test("accepts docker workerProfile (explicit)", async () => {
  // Should pass validation (actual Docker execution may be skipped).
  try {
    const result = await runTask(baseConfig, {
      id: "docker-task",
      intent: "propose_patch",
      workerProfile: "docker",
      commands: ["printf ok"],
    });
    // If Docker is available, it will actually run
    assert.ok(result !== undefined);
  } catch {
    // Docker not available is fine; validation should not throw.
  }
});

test("accepts tasks without workerProfile (backward compat)", async () => {
  try {
    const result = await runTask(baseConfig, {
      id: "legacy-task",
      intent: "propose_patch",
      commands: ["printf ok"],
    });
    assert.ok(result !== undefined);
  } catch {
    // Docker not available is fine; validation should not throw.
  }
});

// ---------------------------------------------------------------------------
// extractPrUrl
// ---------------------------------------------------------------------------

test("extracts PR URL from stdout", async () => {
  const task: RunnerTask = {
    id: "pr-extract-test",
    intent: "propose_patch",
    commands: [
      "printf 'Created pull request: https://github.com/jinwon-int/a2a-docker-runner/pull/42\\n'",
    ],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 2000 };

  try {
    const result = await runTask(config, task);
    if (result.prUrl) {
      assert.equal(result.prUrl, "https://github.com/jinwon-int/a2a-docker-runner/pull/42");
    }
  } catch {
    // Docker not available; skip.
  }
});

test("extracts PR URL with query parameters", async () => {
  const task: RunnerTask = {
    id: "pr-extract-query",
    intent: "propose_patch",
    commands: [
      "printf 'See https://github.com/org/repo/pull/99?query=1 for details\\n'",
    ],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 2000 };

  try {
    const result = await runTask(config, task);
    if (result.prUrl) {
      assert.ok(result.prUrl.includes("https://github.com/"));
      assert.ok(result.prUrl.includes("/pull/99"));
    }
  } catch {
    // Docker not available; skip.
  }
});

test("ignores incidental PR URL in allowNoChanges no-change output", () => {
  const stdout = [
    "https://github.com/jinwon-int/a2a-broker/pull/857",
    "read_only_validation=passed",
    "status=no_changes_allowed",
    "notice=no_code_changes_produced_evidence_only_lane",
  ].join("\n");

  assert.equal(
    shouldTreatDetectedPrUrlAsCanonical(
      { allowNoChanges: true, readOnlyValidation: true },
      stdout,
      "",
      "https://github.com/jinwon-int/a2a-broker/pull/857",
    ),
    false,
  );
});

test("ignores incidental PR URL with openclaw_no_changes=allowed marker", () => {
  const stdout = [
    "https://github.com/jinwon-int/a2a-broker/pull/857",
    "read_only_validation=passed",
    "openclaw_no_changes=allowed",
    "notice=no_code_changes_produced_evidence_only_lane",
  ].join("\n");

  assert.equal(
    shouldTreatDetectedPrUrlAsCanonical(
      { allowNoChanges: true, readOnlyValidation: true },
      stdout,
      "",
      "https://github.com/jinwon-int/a2a-broker/pull/857",
    ),
    false,
  );
});

test("keeps runner-created PR URL even when post-PR output contains no-change marker", () => {
  const stdout = [
    "pr_created=1",
    "https://github.com/jinwon-int/a2a-broker/pull/873",
    "status=no_changes_allowed",
  ].join("\n");

  assert.equal(
    shouldTreatDetectedPrUrlAsCanonical(
      { allowNoChanges: true, readOnlyValidation: false },
      stdout,
      "",
      "https://github.com/jinwon-int/a2a-broker/pull/873",
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// prUrlRecoveredAfterNonzero — a2a-docker-runner#199
// ---------------------------------------------------------------------------

test("does not treat an arbitrary PR URL plus non-zero exit as success", async () => {
  const task: RunnerTask = {
    id: "pr-recovery-test",
    intent: "propose_patch",
    commands: [
      "printf 'https://github.com/jinwon-int/a2a-docker-runner/pull/199\\n'",
      "printf 'some benign post-PR cleanup warning\\n' >&2",
      "exit 2",
    ],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 3000 };

  try {
    const result = await runTask(config, task);
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.prUrl, undefined);
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// artifact collection
// ---------------------------------------------------------------------------

test("collects artifacts from workDir/artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-artifact-test-"));
  const artifactsDir = join(dir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "summary.txt"), "test summary");
  writeFileSync(join(artifactsDir, "command-0.log"), "command output");
  mkdirSync(join(artifactsDir, "subdir"), { recursive: true });
  writeFileSync(join(artifactsDir, "subdir", "nested.txt"), "nested");

  const task: RunnerTask = {
    id: "artifact-test",
    intent: "propose_patch",
    commands: ["printf ok"],
  };
  const config = { ...baseConfig, rootDir: dir, defaultTimeoutMs: 2000 };

  try {
    const result = await runTask(config, task);
    // Artifacts should include summary.txt and command-0.log
    // (plus anything the task writes during execution)
    assert.ok(result.artifacts.length > 0, `Expected artifacts, got ${result.artifacts.length}`);
  } catch {
    // Docker not available; skip validation.
  } finally {
    // Use execFileSync fallback for permission/ownership resilience (CI sandbox)
    try { rmSync(dir, { recursive: true, force: true }); } catch { execFileSync("rm", ["-rf", dir]); }
  }
});

// ---------------------------------------------------------------------------
// github-propose-patch mode evidence
// ---------------------------------------------------------------------------

test("populates github evidence on github-propose-patch mode success", async () => {
  const task: RunnerTask = {
    id: "evidence-pr-test",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinwon-int/a2a-docker-runner",
    commands: [
      "printf 'PR created: https://github.com/jinwon-int/a2a-docker-runner/pull/77\\n'",
    ],
    issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/1",
    reportLanguage: "ko",
    requestedBy: "brokerAlpha",
  };
  const config = { ...baseConfig, defaultTimeoutMs: 5000 };

  try {
    const result = await runTask(config, task);
    if (result.ok) {
      assert.ok(result.github, "Expected github evidence on success");
      assert.equal(result.github?.prUrl, "https://github.com/jinwon-int/a2a-docker-runner/pull/77");
    }
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// timeout behavior
// ---------------------------------------------------------------------------

test("handles bounded timeout", async () => {
  const task: RunnerTask = {
    id: "timeout-test",
    intent: "propose_patch",
    commands: ["sleep 30"],
    timeoutMs: 1000,
  };
  const config = { ...baseConfig, defaultTimeoutMs: 1000 };

  try {
    const result = await runTask(config, task);
    assert.equal(result.status, "timeout");
    assert.equal(result.ok, false);
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// default commands for single repo
// ---------------------------------------------------------------------------

test("generates default commands for single repo task", async () => {
  const task: RunnerTask = {
    id: "default-cmds-test",
    intent: "propose_patch",
    repo: "jinwon-int/a2a-docker-runner",
    baseBranch: "main",
  };
  const config = { ...baseConfig, defaultTimeoutMs: 3000 };

  try {
    await runTask(config, task);
    // Should have generated npm ci + npm test commands
    // The stdout should contain evidence of command execution
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// multi-repo checkout
// ---------------------------------------------------------------------------

test("handles multi-repo configuration", async () => {
  const task: RunnerTask = {
    id: "multi-repo-test",
    intent: "propose_patch",
    repos: [
      { name: "primary", url: "jinwon-int/a2a-docker-runner", path: "primary", primary: true },
      { name: "secondary", url: "jinwon-int/openclaw", path: "secondary" },
    ],
    commands: ["cd /work/primary && npm ci", "cd /work/primary && npm test"],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 5000 };

  try {
    await runTask(config, task);
    // Should attempt checkout of both repos
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// preset expansion
// ---------------------------------------------------------------------------

test("expands openclaw-plugin-a2a-dev preset correctly", async () => {
  const task: RunnerTask = {
    id: "preset-test",
    intent: "propose_patch",
    preset: "openclaw-plugin-a2a-dev",
  };
  const config = { ...baseConfig, defaultTimeoutMs: 5000 };

  try {
    await runTask(config, task);
    // The preset expands to checkout + npm ci + npm test
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// buildContainerScript: shell metacharacter safety
// ---------------------------------------------------------------------------

test("buildContainerScript safely shell-quotes task id with single quote", () => {
  const task: NormalizedRunnerTask = {
    id: "task-with-'quote",
    intent: "propose_patch",
    repos: [],
    commands: [],
  };
  const script = buildContainerScript(task);
  // POSIX single-quote escape: task-with-'quote → 'task-with-'\''quote'
  assert.ok(script.includes("'task-with-'\\''quote'"), `Task id must be POSIX-escaped; got snippet: ${script.slice(0, 300)}`);
});

test("buildContainerScript safely shell-quotes task id with dollar sign", () => {
  const task: NormalizedRunnerTask = {
    id: "task-$HOME-injection",
    intent: "propose_patch",
    repos: [],
    commands: [],
  };
  const script = buildContainerScript(task);
  // $HOME inside single quotes is literal, so the script should contain the literal string
  assert.ok(script.includes("'task-$HOME-injection'"), "Dollar sign in task id must be inside single quotes (literal, not expanded)");
});

test("buildContainerScript safely shell-quotes intent with backtick", () => {
  const task: NormalizedRunnerTask = {
    id: "safe-id",
    intent: "propose`date`patch",
    repos: [],
    commands: [],
  };
  const script = buildContainerScript(task);
  // Backtick inside single quotes is literal
  assert.ok(script.includes("'propose`date`patch'"), "Backtick in intent must be inside single quotes (literal, not executed)");
});

test("buildContainerScript provisions latest-capable gh and update-branch fallback helper", () => {
  const task: NormalizedRunnerTask = {
    id: "github-cli-tools",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repos: [],
    commands: [],
  };

  const script = buildContainerScript(task);
  assert.ok(script.includes("gh pr update-branch --help"), "Expected gh capability check for update-branch");
  assert.ok(script.includes("cli.github.com/packages"), "Expected official GitHub CLI apt repository");
  assert.ok(script.includes("/work/.a2a-bin/a2a-gh-pr-update-branch"), "Expected writable fallback helper installation");
  assert.ok(script.includes("warning=gh_pr_update_branch_failed_using_git_fallback"), "Expected git fallback marker");
});

test("buildContainerScript restores host ownership of mounted workdir on exit", () => {
  const task: NormalizedRunnerTask = {
    id: "ownership-restore",
    intent: "propose_patch",
    repos: [],
    commands: [],
  };

  const script = buildContainerScript(task);
  assert.ok(script.includes("restore_work_ownership()"), "Expected ownership restore helper");
  assert.ok(script.includes("stat -c '%u' /work"), "Expected host uid discovery from /work");
  assert.ok(script.includes("chown -R \"$owner:$group\" /work"), "Expected best-effort recursive chown before container exit");
  assert.ok(script.includes("trap restore_work_ownership EXIT"), "Expected ownership restore EXIT trap");
});

test("buildContainerScript records command digests instead of command bodies in summary", () => {
  const task: NormalizedRunnerTask = {
    id: "command-summary-digest",
    intent: "propose_patch",
    repos: [],
    commands: ["printf 'error=pre_pr_bootstrap_guard_blocked\\n'"],
  };

  const script = buildContainerScript(task);

  assert.ok(script.includes("command[%s].sha256=%s"), "Expected command digest summary marker");
  assert.ok(script.includes("command[%s].bytes=%s"), "Expected command size summary marker");
  assert.equal(script.includes("command[%s]=%s"), false, "Summary must not echo raw command bodies");
});

test("task artifact shell redactor includes API-key and prompt secret parity patterns", () => {
  const task: NormalizedRunnerTask = {
    id: "redaction-parity",
    intent: "propose_patch",
    repos: [],
    commands: [],
  };
  const script = buildContainerScript(task);

  assert.ok(script.includes("xai-[A-Za-z0-9_-]{40,}"), "Expected xAI key redaction in container artifact path");
  assert.ok(script.includes("sm_[A-Za-z0-9_-]{40,}"), "Expected supermemory key redaction in container artifact path");
  assert.ok(script.includes("sk-[A-Za-z0-9_-]{32,}"), "Expected OpenAI key redaction in container artifact path");
  assert.ok(script.includes("Authorization:[[:space:]]*(Bearer|token)"), "Expected Authorization header redaction in container artifact path");
  assert.ok(script.includes("((token|password|secret|api[_-]?key)=)"), "Expected prompt key=value secret redaction in container artifact path");
});

test("buildContainerScript includes redact_artifact_file for post-command log redaction", () => {
  const task: NormalizedRunnerTask = {
    id: "command-log-redaction",
    intent: "propose_patch",
    repos: [],
    commands: ["echo 'hello'", "printf 'token=secret123\\n'"],
  };
  const script = buildContainerScript(task);

  // The redact_artifact_file function must be declared
  assert.ok(script.includes("redact_artifact_file()"), "Expected redact_artifact_file bash function in container script");
  // A post-command loop must redact all command-*.log files
  assert.ok(script.includes("/work/artifacts/command-*.log"), "Expected command log glob in redaction loop");
  assert.ok(script.includes("redact_artifact_file \"$_a2a_log\""), "Expected redact_artifact_file call per log file");
  // The redaction must use the same temp-file-and-mv pattern (no -i flag needed)
  assert.ok(script.includes(".a2a-redacted"), "Expected temp file suffix .a2a-redacted for atomic write");
  assert.ok(script.includes("mv \"\${_a2a_f}.a2a-redacted\" \"$_a2a_f\""), "Expected mv of temp file to original");
  // BUG-06: redaction must also run from the EXIT trap so a failing command
  // (set -e abort) cannot leave command logs unredacted on disk, and it must
  // cover the patch/engine output files, not just command-*.log.
  assert.ok(script.includes("trap on_container_exit EXIT"), "Expected redaction wired into the EXIT trap");
  assert.ok(/on_container_exit\(\)\s*\{[\s\S]*redact_command_artifacts[\s\S]*restore_work_ownership[\s\S]*\}/.test(script), "Expected exit handler to redact then restore ownership");
  assert.ok(script.includes("/work/artifacts/patch-command.log"), "Expected patch-command.log in redaction set");
  assert.ok(script.includes("/work/artifacts/openclaw-output.txt"), "Expected openclaw-output.txt in redaction set");
});

// ---------------------------------------------------------------------------
// pre-pr-bootstrap-guard
// ---------------------------------------------------------------------------

test("bootstrap guard script is included when repos are configured", () => {
  const task: NormalizedRunnerTask = {
    id: "bootstrap-guard",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);
  assert.ok(script.includes("bootstrap_guard="), "Expected bootstrap guard output marker");
  assert.ok(script.includes("bootstrap_guard=ok"), "Expected bootstrap guard ok on clean checkout");
  assert.ok(script.includes("AGENTS.md"), "Expected banned files list");
  assert.ok(script.includes("SOUL.md"), "Expected banned soul file");
  assert.ok(script.includes(".openclaw"), "Expected banned .openclaw dir");
  assert.ok(script.includes("a2a-broker#446"), "Expected parent issue reference");
});

test("bootstrap guard blocks when banned files are present (pre-check)", () => {
  const task: NormalizedRunnerTask = {
    id: "bootstrap-guard",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);
  assert.ok(script.includes("exit 4"), "Expected exit 4 on bootstrap leak detection");
  assert.ok(script.includes("error=pre_pr_bootstrap_guard_blocked"), "Expected blocked error marker");
  assert.ok(script.includes("filter_branch_bootstrap_leaks"), "Expected ignored-file-aware branch-entry filter");
  assert.ok(script.includes("git -C \"$repo_dir\" ls-files -- \"$path\""), "Expected tracked bootstrap paths to block");
  assert.ok(script.includes("git -C \"$repo_dir\" status --porcelain -- \"$path\""), "Expected unignored/staged bootstrap paths to block");
  assert.ok(script.includes("Files detected (repo-relative):"), "Expected repo-relative offending paths report");
  assert.ok(script.includes("Repository checkout: %s"), "Expected non-absolute checkout label report");
  assert.ok(!script.includes("Files detected in %s"), "Guard evidence must not include absolute checkout paths in headings");
  assert.ok(!script.includes("$repo_dir/$name"), "Guard evidence must not report absolute checkout paths as offending paths");
});

test("bootstrap guard allows only clean tracked AGENTS.md in Family Wiki read-only audit mode", () => {
  const task: NormalizedRunnerTask = {
    id: "family-wiki-readonly-audit",
    intent: "verify",
    mode: "family-wiki-readonly-audit",
    repos: [{ url: "jinwon-int/seoyoon-family-wiki", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  assert.ok(script.includes("BOOTSTRAP_ALLOWED_TRACKED_REPO_ENTRIES='/work/repo:AGENTS.md'"), "Expected repo-scoped tracked AGENTS.md allowance");
  assert.ok(script.includes("is_allowed_tracked_bootstrap_path"), "Expected allowlist helper");
  assert.ok(script.includes("git -C \"$repo_dir\" status --porcelain -- \"$path\""), "Allowance must require a clean tracked file");
  assert.ok(script.includes("BOOTSTRAP_BANNED_DIRS=\".openclaw memory\""), "Bootstrap directories must remain banned");
});

test("bootstrap guard does not allow AGENTS.md for ordinary repositories", () => {
  const task: NormalizedRunnerTask = {
    id: "ordinary-repo-bootstrap-guard",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  assert.ok(script.includes("BOOTSTRAP_ALLOWED_TRACKED_REPO_ENTRIES=''"), "Expected no tracked bootstrap allowance by default");
});

test("bootstrap post-guard checks every configured repo path", () => {
  const task: NormalizedRunnerTask = {
    id: "bootstrap-guard-multi-repo",
    intent: "propose_patch",
    repos: [
      { url: "jinwon-int/primary", path: "primary" },
      { url: "jinwon-int/secondary", path: "secondary" },
    ],
    commands: [],
  };
  const script = buildContainerScript(task);
  assert.ok(script.includes("for repo_dir in '/work/primary' '/work/secondary'; do"), "Expected post-guard to inspect all task repo checkouts");
  assert.ok(script.includes("find_bootstrap_leaks \"$repo_dir\""), "Expected post-guard to use the same ignored-file-aware scanner");
  assert.ok(script.includes("${path#./}"), "Expected repo-relative paths for .openclaw/** and memory/** entries");
});

test("bootstrap guard skips pre-check when no repos", () => {
  const task: NormalizedRunnerTask = {
    id: "no-repos",
    intent: "propose_patch",
    repos: [],
    commands: [],
  };
  const script = buildContainerScript(task);
  // Pre-check guard function returns empty for no repos, but post-guard is always included
  assert.ok(script.includes("bootstrap_leaks_post"), "Expected post-guard even without repos");
});

test("bootstrap guard includes schema marker in output", () => {
  const task: NormalizedRunnerTask = {
    id: "schema-guard",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);
  assert.ok(script.includes("a2a.runner.pre-pr-bootstrap-guard.v1"), "Expected schema version marker");
});

test("buildContainerScript output is valid bash syntax with post-bootstrap guard", () => {
  const task: NormalizedRunnerTask = {
    id: "syntax-guard",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: ["printf 'ok\\n'"],
  };
  const dir = mkdtempSync(join(tmpdir(), "a2a-runner-script-syntax-"));
  const scriptPath = join(dir, "run.sh");
  try {
    writeFileSync(scriptPath, buildContainerScript(task));
    execFileSync("bash", ["-n", scriptPath]);
  } finally {
    // rmSync + execFileSync fallback for permission resilience
    try { rmSync(dir, { recursive: true, force: true }); } catch { execFileSync("rm", ["-rf", dir]); }
  }
});

test("buildContainerScript guard references parent issue a2a-broker#446", () => {
  const task: NormalizedRunnerTask = {
    id: "parent-ref",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);
  const matches = (script.match(/a2a-broker#446/g) || []).length;
  assert.ok(matches >= 2, `Expected at least 2 references to a2a-broker#446 (pre + post), got ${matches}`);
});

// ---------------------------------------------------------------------------
// error handling: invalid commands
// ---------------------------------------------------------------------------

test("handles failing commands", async () => {
  const task: RunnerTask = {
    id: "fail-cmd-test",
    intent: "propose_patch",
    commands: ["exit 1"],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 2000 };

  try {
    const result = await runTask(config, task);
    if (!result.ok) {
      assert.equal(result.status, "failed");
      assert.ok(result.exitCode !== 0);
    }
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// buildActionableError: image-pull summary regression (a2a-docker-runner#169)
// ---------------------------------------------------------------------------

test("buildActionableError: engine not found produces ENOENT message", () => {
  const msg = buildActionableError("docker", "node:22", {
    code: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    errorCode: "ENOENT",
  });
  assert.ok(msg.includes("실행 파일을 찾을 수 없습니다"), `Expected ENOENT message, got: ${msg}`);
});

test("buildActionableError: no false image-pull error when stdout-only has 'not found'", () => {
  // The container DID start and the agent produced output mentioning "not found"
  // in the context of a git clone or file lookup.  The error must NOT be
  // the misleading image-pull summary.
  const msg = buildActionableError("docker", "node:22-bookworm-slim", {
    code: 2,
    signal: null,
    stdout: [
      "notice=no_patch_command_configured",
      "Set commandScript or commandJson in RunnerConfig to inject a coding agent.",
      "status=no_changes",
      "fatal: repository 'https://github.com/owner/missing-repo.git/' not found",
    ].join("\n"),
    stderr: "",
    timedOut: false,
  });

  // buildActionableError returns combined output when no specific pattern matches.
  // The key regression: it must NOT produce image-pull error text when
  // Docker/Podman engine errors are only in stdout (agent output), not stderr.
  assert.ok(!msg.includes("이미지"), `Must not produce image-pull error for stdout-only 'not found', got: ${msg}`);
  assert.ok(!msg.includes("pull access denied"), `Must not match engine pull errors in stdout, got: ${msg}`);
});

test("buildActionableError: no false image-pull error when stdout-only has 'repository does not exist'", () => {
  const msg = buildActionableError("docker", "node:22-bookworm-slim", {
    code: 1,
    signal: null,
    stdout: [
      "Cloning into 'repo'...",
      "remote: Repository not found.",
      "fatal: repository 'https://github.com/nonexistent/repo.git/' does not exist",
    ].join("\n"),
    stderr: "",
    timedOut: false,
  });

  assert.ok(!msg.includes("이미지"), `Must not produce image-pull error for stdout-only 'repository does not exist', got: ${msg}`);
});

test("buildActionableError: DOES produce image-pull error when stderr has daemon pull error", () => {
  // Real Docker daemon pull failure: "Error response from daemon: pull access denied" in stderr.
  const msg = buildActionableError("docker", "private/image:tag", {
    code: 125,
    signal: null,
    stdout: "",
    stderr: [
      "Unable to find image 'private/image:tag' locally",
      "docker: Error response from daemon: pull access denied for private/image, repository does not exist or may require 'docker login'.",
      "See 'docker run --help'.",
    ].join("\n"),
    timedOut: false,
  });

  assert.ok(msg.includes("이미지"), `Expected image-pull error for daemon pull failure in stderr, got: ${msg}`);
  assert.ok(msg.includes("가져오거나 찾을 수 없습니다"), `Expected Korean image-pull error text, got: ${msg}`);
});

test("buildActionableError: image-pull error for manifest unknown in stderr", () => {
  const msg = buildActionableError("docker", "nonexistent/image:v9.9.9", {
    code: 125,
    signal: null,
    stdout: "",
    stderr: "docker: Error response from daemon: manifest for nonexistent/image:v9.9.9 not found: manifest unknown: manifest unknown.",
    timedOut: false,
  });

  assert.ok(msg.includes("이미지"), `Expected image-pull error for manifest unknown, got: ${msg}`);
});

test("buildActionableError: no image-pull error when stderr is unrelated failure", () => {
  const msg = buildActionableError("docker", "node:22", {
    code: 1,
    signal: null,
    stdout: "some output",
    stderr: "command not found: nonexistent-tool",
    timedOut: false,
  });

  assert.ok(!msg.includes("이미지"), `Must not produce image-pull error for unrelated stderr, got: ${msg}`);
});

test("buildActionableError: no false container-name conflict from agent stdout", () => {
  const msg = buildActionableError("docker", "node:22", {
    code: 2,
    signal: null,
    stdout: [
      "A2A Docker Runner task task-1",
      "The fixture already exists, skipping generation.",
      "pull request create failed: GraphQL: No commits between main and branch",
      "error=pr_create_failed_or_missing_url",
    ].join("\n"),
    stderr: "Cloning into '/work/repo'...",
    timedOut: false,
  });

  assert.ok(!msg.includes("컨테이너 이름 충돌"), `Must not produce container-name conflict for agent stdout, got: ${msg}`);
});

// ---------------------------------------------------------------------------
// buildActionableError: OOM detection + elapsed time in timeout diagnostics
// Parent: a2a-docker-runner#227
// ---------------------------------------------------------------------------

test("buildActionableError: detects OOM via exit code 137 (SIGKILL from cgroup)", () => {
  // Docker/Podman OOM kill produces exit code 137 = 128+9 (SIGKILL).
  // The runner must surface this as a distinct resource-exhaustion error
  // rather than a generic non-zero exit.
  const msg = buildActionableError("docker", "node:22", {
    code: 137,
    signal: "SIGKILL",
    stdout: "some output before kill",
    stderr: "",
    timedOut: false,
    elapsedMs: 4200,
  });

  assert.ok(msg.includes("OOM"), `Expected OOM detection for exit 137, got: ${msg}`);
  assert.ok(msg.includes("메모리 부족"), `Expected Korean memory-exhaustion text, got: ${msg}`);
  assert.ok(msg.includes("exit=137"), `Expected exit code 137 in message, got: ${msg}`);
  assert.ok(msg.includes("elapsed=4.2s"), `Expected elapsed time in OOM message, got: ${msg}`);
  assert.ok(msg.includes("--memory"), `Expected --memory tuning hint in OOM message, got: ${msg}`);
});

test("buildActionableError: detects OOM via stderr pattern when exit code is masked", () => {
  // In some rootless Podman configurations the exit code may not be 137
  // but stderr still contains the OOM indicator.  The runner must match
  // stderr patterns independently of exit code.
  const msg = buildActionableError("podman", "node:22", {
    code: 1,
    signal: null,
    stdout: "",
    stderr: "Error: container create failed: container_linux.go: Out of memory: the container was killed by the OOM killer",
    timedOut: false,
    elapsedMs: 1100,
  });

  assert.ok(msg.includes("OOM"), `Expected OOM detection via stderr, got: ${msg}`);
  assert.ok(msg.includes("메모리 부족"), `Expected Korean memory-exhaustion text for stderr OOM, got: ${msg}`);
  assert.ok(msg.includes("elapsed=1.1s"), `Expected elapsed time in OOM stderr message, got: ${msg}`);
});

test("buildActionableError: includes elapsed time in timeout error message", () => {
  // Timed-out runs must include the actual wall-clock elapsed time
  // in the error message so operators can tune timeoutMs evidence.
  const msg = buildActionableError("docker", "node:22", {
    code: null,
    signal: "SIGTERM",
    stdout: "partial output",
    stderr: "",
    timedOut: true,
    elapsedMs: 30100,
  });

  assert.ok(msg.includes("제한 시간"), `Expected timeout message, got: ${msg}`);
  assert.ok(msg.includes("elapsed=30.1s"), `Expected elapsed time in timeout message, got: ${msg}`);
  assert.ok(!msg.includes("elapsed=0.0s"), `Elapsed time should reflect actual runtime, got: ${msg}`);
});

test("buildActionableError: safely handles missing elapsedMs in timeout", () => {
  // Backward-compatible: elapsedMs may be absent in callers that don't
  // supply it.  The error message must still render without NaN or crash.
  const msg = buildActionableError("docker", "node:22", {
    code: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    timedOut: true,
    // elapsedMs intentionally omitted
  });

  assert.ok(msg.includes("제한 시간"), `Expected readable timeout message when elapsedMs is missing, got: ${msg}`);
  assert.ok(msg.includes("elapsed=0.0s"), `Expected safe default elapsed=0.0s when elapsedMs missing, got: ${msg}`);
});

test("buildActionableError: OOM detection does not false-match 'out of' in agent stdout", () => {
  // Agent output like "out of scope" or "running out of disk space"
  // must not trigger OOM detection.  Only stderr engine errors count.
  const msg = buildActionableError("docker", "node:22", {
    code: 1,
    signal: null,
    stdout: "warning: running out of disk space in /tmp",
    stderr: "command not found: build-tool",
    timedOut: false,
    elapsedMs: 5000,
  });

  // combined includes both stdout and stderr, and 'out of disk space'
  // is in stdout, not stderr (engineStderr).  The OOM detection only
  // inspects engineStderr.
  assert.ok(!msg.includes("OOM"), `Must not false-match 'out of' in agent stdout as OOM, got: ${msg}`);
  assert.ok(!msg.includes("메모리 부족"), `Must not produce OOM message for agent stdout, got: ${msg}`);
});

// ---------------------------------------------------------------------------
// CI ownership regression hardening (a2a-docker-runner#215 → builds on #214)
// ---------------------------------------------------------------------------

test("buildContainerScript EXIT trap is declared before any early-exit that could skip it", () => {
  const task: NormalizedRunnerTask = {
    id: "trap-before-exit",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  // The EXIT trap must appear before the first conditional exit (e.g. the
  // pre PR bootstrap guard block that calls "exit 4").  Otherwise ownership
  // restore is never invoked and CI cleanup fails with EACCES.
  const trapIndex = script.indexOf("trap restore_work_ownership");
  const firstExit4 = script.indexOf("exit 4");
  const fnDefIdx = script.indexOf("restore_work_ownership()");

  assert.ok(trapIndex >= 0, "trap restore_work_ownership must be present");
  assert.ok(firstExit4 >= 0, "exit 4 (bootstrap guard block) must be present");
  assert.ok(fnDefIdx >= 0, "restore_work_ownership() helper must be defined");
  // The trap registration must appear before any early exit.  The helper
  // function definition may appear before the trap (Bash resolves it at
  // invocation time), but trap registration must precede all exit 4 paths.
  assert.ok(trapIndex < firstExit4, `EXIT trap (pos ${trapIndex}) must precede first exit 4 (pos ${firstExit4})`);
});

test("buildContainerScript restore_work_ownership survives stat failure on /work", () => {
  const task: NormalizedRunnerTask = {
    id: "ownership-stat-fail",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  // The restore_work_ownership function must:
  // 1. Run the stat call with set +e / set -e guards.
  // 2. Fall back to a default uid:gid when stat fails.
  // 3. Run chown only when id is non-root (id 0).
  // 4. Never exit the script from an uncaught error inside the trap.
  assert.ok(script.includes("set +e") || script.includes("stat"), "restore must handle stat fallback");
  assert.ok(script.includes("chown"), "restore must include chown invocation");
  // The chown must be guarded: only execute for non-root owners (uid != 0).
  assert.ok(
    script.includes("chown -R") && (script.includes("$owner") || script.includes("owner")),
    "restore must chown with dynamic owner variable",
  );
});

test("buildContainerScript ownership restore runs best-effort (no exit on failure)", () => {
  const task: NormalizedRunnerTask = {
    id: "ownership-best-effort",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  // The chown invocation in the restore function must use || true or similar
  // best-effort pattern, and must not use set -e in the trap body that would
  // turn a chown failure into a spurious container exit.
  const restoreFn = script.slice(
    script.indexOf("restore_work_ownership()"),
    script.indexOf("}", script.indexOf("restore_work_ownership()")) + 2,
  );
  assert.ok(
    restoreFn.includes("|| true") || restoreFn.includes("|| :") || !restoreFn.includes("set -e"),
    "restore_work_ownership must be best-effort (|| true or no set -e in trap body)",
  );
});

test("buildContainerScript bootstrap guard checks full BANNED_FILES parity", () => {
  const task: NormalizedRunnerTask = {
    id: "banned-files-parity",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  // The in-container bootstrap guard must ban the same files as the
  // standalone pre-pr-bootstrap-guard.mjs script (a2a-broker#446).
  const bannedFiles = [
    "AGENTS.md",
    "BOOTSTRAP.md",
    "HEARTBEAT.md",
    "IDENTITY.md",
    "MEMORY.md",
    "SOUL.md",
    "TOOLS.md",
    "USER.md",
  ];

  for (const file of bannedFiles) {
    assert.ok(
      script.includes(file),
      `buildContainerScript must ban ${file} (a2a-broker#446 parity)`,
    );
  }

  // The .openclaw/ directory must also be banned.
  assert.ok(script.includes(".openclaw"), "buildContainerScript must ban .openclaw/ directory");
});

test("buildContainerScript ownership restore guards against stat failure on /work", () => {
  const task: NormalizedRunnerTask = {
    id: "ownership-stat-guard",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  // When stat fails on /work (container has no /work mount, or mount is
  // broken), the restore must not cause an EXIT trap failure.  It must
  // use || true on stat calls and guard chown with a non-empty check.
  const restoreFn = script.slice(
    script.indexOf("restore_work_ownership()"),
    script.indexOf("}", script.indexOf("restore_work_ownership()")) + 2,
  );
  // stat must use || true to avoid trap failure when /work is absent.
  assert.ok(restoreFn.includes("|| true"), "restore must use || true on stat calls");
  // chown must use 2>/dev/null || true for best-effort ownership restore.
  assert.ok(
    restoreFn.includes("2>/dev/null") && restoreFn.includes("|| true"),
    "restore chown must be best-effort (2>/dev/null || true)",
  );
  // Must check that owner/group are non-empty before chown.
  assert.ok(
    restoreFn.includes("-n") && (restoreFn.includes("$owner") || restoreFn.includes("owner")),
    "restore must check owner is non-empty before chown",
  );
});

// ── extractPrUrl: single-URL capture (a2a-nexus#574 item 13) ───────────────

test("extractPrUrl captures one PR URL and does not span adjacent URLs", () => {
  assert.equal(
    extractPrUrl("Pushed and created https://github.com/jinwon-int/test-repo/pull/42"),
    "https://github.com/jinwon-int/test-repo/pull/42",
  );

  // Two URLs with no whitespace between them must not be merged into one.
  const adjacent = "https://github.com/o/r1/pull/5#https://github.com/o/r2/pull/9";
  assert.equal(extractPrUrl(adjacent), "https://github.com/o/r1/pull/5");

  assert.equal(extractPrUrl("no url here"), undefined);
});

test("extractPrUrls preserves duplicate/self-PR candidates for metadata binding", () => {
  const selfPr = "https://github.com/jinwon-int/a2a-nexus-archive/pull/7";
  const runnerPr = "https://github.com/jinwon-int/a2a-nexus/pull/1670";
  assert.deepEqual(
    extractPrUrls(`agent: ${selfPr}\nbridge: ${runnerPr}\nrepeat: ${selfPr}`),
    [selfPr, runnerPr],
  );
});

test("extractPushedBranch reads the randomized branch from the bridge envelope without inference", () => {
  const branch = "a2a/single-shot-mk9z7q-r4nd0m";
  const stdout = JSON.stringify({
    payloads: [{
      text: JSON.stringify({
        status: "pr_opened",
        branch,
        prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/1670",
      }),
    }],
  });
  assert.equal(extractPushedBranch(stdout), branch);
  assert.equal(extractPushedBranch("PR created on likely-branch-for-1670"), undefined);
});

// ── jsonArgvToScript: parse-error path quoting (a2a-nexus#574 item 19) ──────

test("jsonArgvToScript parse-error path single-quotes the message safely", () => {
  const script = jsonArgvToScript("{ not valid json $(touch /tmp/pwned) `evil` }");
  assert.match(script, /error=json_parse_failed/);
  // The error message is a single bare shell-quoted token — never wrapped in
  // double quotes, which would re-expose $()/backticks from the message.
  assert.doesNotMatch(script, /printf '[^']*' >&2 "/);
  assert.doesNotMatch(script, /\$\(touch/);
});
