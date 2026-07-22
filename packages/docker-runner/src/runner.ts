import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, chown, mkdir, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { runContainerWithRetry } from "./container-retry.js";
import { pruneFailureOutputLogs, writeFailureOutputLog } from "./failure-output-log.js";
import { buildContainerScript, jsonArgvToScript } from "./script-generators.js";
// Re-exported to preserve the public surface (runner.test.ts / engine-contract.test.ts
// import these from ./runner.js); the implementations now live in script-generators.ts.
export { buildContainerScript, jsonArgvToScript };
import { normalizeTask } from "./task-normalizer.js";
import { collectGitHubEvidence } from "./github-evidence.js";
import { sanitizeSourcePublicExecutionPreflight } from "./source-public-preflight.js";
import { expandTask, resolveTemplate, buildTemplateExpansionEvidence } from "./task-templates.js";
import { buildExecutionProof } from "./execution-proof.js";
import { detectEmbeddedModelTimeoutNoFallback } from "./failure-classification.js";
import { redactAndBound, redactSecrets } from "./redaction.js";
export { RESULT_STREAM_LIMIT, redactAndBound, redactSecrets } from "./redaction.js";
import type { ArtifactEvidencePart, ArtifactManifest, ArtifactManifestEntry, ArtifactManifestStatus, CleanupRehearsalEvidence, GitHubCommentProjection, GitHubCommentProjectionKind, NormalizedRunnerTask, ResultSummary, RunnerBudgetEvidence, RunnerConfig, RunnerContainedSubagentRole, RunnerContinuationEvidence, RunnerDiffHygieneEvidence, RunnerEvidenceHints, RunnerPostPatchVerificationEvidence, RunnerReceiptTrace, RunnerReproducibilityMetadata, RunnerResult, RunnerSubagentReport, RunnerTask, SourcePublicApprovalDecision, SourcePublicApprovalPacket, SourcePublicApprovalRehearsal, SourcePublicExecutionPreflight } from "./types.js";

export interface StructuredSubagentReportOptions {
  maxCount: number;
  maxOutputBytes: number;
  allowedRoles: RunnerContainedSubagentRole[];
}

function boundUtf8(value: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  let output = "";
  let used = 0;
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (used + bytes > limit) break;
    output += codePoint;
    used += bytes;
  }
  return output;
}

/**
 * Extract the bridge's structured helper report from the raw container stream
 * before the generic 8KB stdout view is truncated. The additive RunnerResult
 * field is already redacted and byte-bounded; the broker still performs the
 * authoritative task/worker/plan binding and final redaction/assembly gate.
 */
export function extractStructuredSubagentReport(
  stdout: string,
  options: StructuredSubagentReportOptions,
): RunnerSubagentReport | undefined {
  try {
    const envelope = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const payloads = Array.isArray(envelope.payloads) ? envelope.payloads : [];
    const first = payloads[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return undefined;
    const text = (first as Record<string, unknown>).text;
    if (typeof text !== "string") return undefined;
    const payload = JSON.parse(text) as Record<string, unknown>;
    const report = payload.subagentReport;
    if (!report || typeof report !== "object" || Array.isArray(report)) return undefined;
    const record = report as Record<string, unknown>;
    const count = Number(record.count);
    const entriesRaw = record.entries;
    if (!Number.isInteger(count) || count < 0 || count > options.maxCount) return undefined;
    if (!Array.isArray(entriesRaw) || entriesRaw.length !== count) return undefined;
    const allowedRoles = new Set(options.allowedRoles);
    const seenIds = new Set<string>();
    const entries: RunnerSubagentReport["entries"] = [];
    for (const candidate of entriesRaw) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
      const item = candidate as Record<string, unknown>;
      const role = typeof item.role === "string" ? item.role.trim() as RunnerContainedSubagentRole : undefined;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const status = typeof item.status === "string" ? item.status.trim().toLowerCase() : "complete";
      const output = typeof item.output === "string" ? item.output : undefined;
      const rawWriteSet = Array.isArray(item.writeSet)
        && item.writeSet.every((path) => typeof path === "string" && path.trim().length > 0)
        ? item.writeSet.map((path) => String(path).trim())
        : item.writeSet === undefined
          ? []
          : undefined;
      if (!role || !allowedRoles.has(role)) return undefined;
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || seenIds.has(id)) return undefined;
      if (!rawWriteSet || !new Set(["complete", "blocked", "failed", "skipped"]).has(status) || output === undefined) return undefined;
      const writeSet = rawWriteSet.map((path) => redactSecrets(path));
      const redactedOutput = redactSecrets(output);
      const redacted = redactedOutput !== output || writeSet.some((path, index) => path !== rawWriteSet[index]);
      const boundedOutput = boundUtf8(redactedOutput, options.maxOutputBytes);
      const truncated = Buffer.byteLength(redactedOutput, "utf8") > Buffer.byteLength(boundedOutput, "utf8");
      seenIds.add(id);
      entries.push({
        role,
        id,
        writeSet,
        status: status as RunnerSubagentReport["entries"][number]["status"],
        output: boundedOutput,
        redacted,
        truncated,
      });
    }
    return { count, entries };
  } catch {
    return undefined;
  }
}

export async function runTask(config: RunnerConfig, task: RunnerTask): Promise<RunnerResult> {
  validateTask(task);

  // ── Non-Docker worker profile guard ───────────────────────────────
  // Reject Hermes/native A2A worker tasks early with a proper Block
  // outcome before any container is started.
  // Parent: a2a-docker-runner#340
  // Parent: a2a-plane#464
  if (task.workerProfile !== undefined && task.workerProfile !== "docker") {
    const blockError = `Docker runner cannot execute tasks with workerProfile "${task.workerProfile}". ` +
      `This task requires a Hermes/native A2A worker runtime. ` +
      `Supported runner profile: docker.`;
    return buildWorkerProfileBlockResult(task, task.workerProfile, blockError);
  }

  // ── Template Expansion (Team1 workerAlpha lane, A2A R23) ────────────────
  // Parent: a2a-docker-runner#261
  // Parent: a2a-plane#335
  let expandedTask: RunnerTask | undefined;
  let templateExpansionEv: ReturnType<typeof buildTemplateExpansionEvidence> | undefined;
  if (task.template || task.inlineTemplate) {
    expandedTask = expandTask(task);
    const template = resolveTemplate(task);
    if (template) {
      templateExpansionEv = buildTemplateExpansionEvidence(task, expandedTask, template);
    }
  }

  const normalizedTask = sanitizeSubagentContextBrief(normalizeTask(expandedTask ?? task));
  const root = resolve(config.rootDir);
  const runToken = createRunToken();
  const safeTaskId = safeId(task.id);
  const taskRoot = join(root, safeTaskId);
  const workDir = join(taskRoot, runToken);
  await mkdir(taskRoot, { recursive: true, mode: 0o700 });
  await mkdir(workDir, { recursive: false, mode: 0o700 });
  await writeFile(join(workDir, "task.json"), JSON.stringify(normalizedTask, null, 2));
  await materializeSubagentContextBrief(workDir, normalizedTask);
  await writeFile(join(workDir, "run.json"), JSON.stringify({
    taskId: task.id,
    safeTaskId,
    runToken,
    createdAt: new Date().toISOString(),
    ...(config.buildMetadata ? { runnerBuild: config.buildMetadata } : {}),
  }, null, 2));

  // Write safe patch command script if configured.
  // Priority: commandScript > commandJson > commandTemplate (legacy eval).
  if (config.commandScript) {
    await writeFile(join(workDir, "patch-command.sh"), config.commandScript, { mode: 0o700 });
  } else if (config.commandJson) {
    const jsonScript = jsonArgvToScript(config.commandJson);
    await writeFile(join(workDir, "patch-command.sh"), jsonScript, { mode: 0o700 });
  }

  const script = buildContainerScript(normalizedTask);
  await writeFile(join(workDir, "run.sh"), script, { mode: 0o700 });
  await prepareWorkDirForContainerUser(workDir, config.user);

  const args = buildRunArgs(config, normalizedTask, workDir, runToken);
  const timeoutMs = normalizedTask.timeoutMs ?? config.defaultTimeoutMs;
  const engine = config.engine ?? "docker";
  // Use retry harness for transient container failures.
  // runContainerWithRetry handles backoff, jitter, and retry evidence tracking.
  const { result: completed, retryEvidence } = await runContainerWithRetry(engine, args, timeoutMs);
  const subagentReport = config.containedSubagents?.enabled
    ? extractStructuredSubagentReport(completed.stdout, {
        maxCount: config.containedSubagents.maxCount,
        maxOutputBytes: config.containedSubagents.outputBytes,
        allowedRoles: config.containedSubagents.roles,
      })
    : undefined;
  await writeSanitizedTaskArtifact(workDir, normalizedTask);
  const artifacts = await listArtifacts(workDir);
  const stdout = redactAndBound(completed.stdout);
  const stderr = redactAndBound(completed.stderr);
  const detectedPrUrl = extractPrUrl(completed.stdout);
  const prUrl = shouldTreatDetectedPrUrlAsCanonical(
    normalizedTask,
    completed.stdout,
    completed.stderr,
    detectedPrUrl,
  )
    ? detectedPrUrl
    : undefined;
  const budgetStop = inferBudgetStopEvidence(stdout, stderr);
  const receiptTrace = sanitizeReceiptTrace(normalizedTask.receiptTrace ?? parseReceiptTraceEnv(normalizedTask.env));
  const postPatchVerification = await readArtifactJson<RunnerPostPatchVerificationEvidence>(workDir, "post-patch-verification.json", isPostPatchVerificationEvidence);
  const diffHygiene = await readArtifactJson<RunnerDiffHygieneEvidence>(workDir, "diff-hygiene.json", isDiffHygieneEvidence);
  const reproducibility = await buildReproducibilityMetadata(config, normalizedTask, workDir);
  const manifest = await buildArtifactManifest(workDir, artifacts, {
    task: normalizedTask,
    status: budgetStop ? "budget_limited" : completed.timedOut ? "failed" : completed.code === 0 ? "done" : "failed",
    stdout,
    stderr,
    prUrl,
    receiptTrace,
    postPatchVerification,
    diffHygiene,
    reproducibility,
    ...(budgetStop ? budgetStop : {}),
  });
  await writeArtifactManifest(workDir, manifest);
  const retryAttempted = retryEvidence.totalAttempts > 1;
  const resultSummary = buildResultSummary(completed, stdout, stderr, artifacts, manifest, config.buildMetadata);
  if (retryAttempted) {
    resultSummary.containerRetryEvidence = retryEvidence;
  }

  // When a PR URL is detected in stdout but the container exited non-zero,
  // treat it as success — the PR was created.  Post-PR cleanup / no-change
  // checks that fail non-zero after PR creation are not patch failures.
  // Parent: a2a-docker-runner#199
  const prUrlRecoveredAfterNonzero = Boolean(prUrl && !completed.timedOut && completed.code !== 0);
  const result: RunnerResult = {
    ok: (completed.code === 0 && !completed.timedOut) || prUrlRecoveredAfterNonzero,
    taskId: task.id,
    status: completed.timedOut ? "timeout" : (completed.code === 0 || prUrlRecoveredAfterNonzero) ? "completed" : "failed",
    workDir,
    exitCode: completed.code,
    signal: completed.signal,
    stdout,
    stderr,
    ...(subagentReport ? { subagentReport } : {}),
    artifacts,
    artifactManifest: manifest,
    resultSummary,
    runnerBuild: config.buildMetadata,
    prUrl,
    error: (completed.code === 0 && !completed.timedOut) || prUrlRecoveredAfterNonzero ? undefined : buildActionableError(engine, config.image, completed),
  };

  if (!result.ok) {
    // #1610 item 2: containers are --rm, so persist the failed run's output
    // on the worker host (redacted, tail-bounded) and keep the volume capped.
    await writeFailureOutputLog(workDir, {
      // raw captured streams: the helper redacts and TAIL-bounds, so the
      // actual error at the end of the output survives (#1610)
      stdout: completed.stdout,
      stderr: completed.stderr,
      maxBytes: config.failureLogMaxBytes,
    });
    await pruneFailureOutputLogs(root, config.failureLogKeep);
  }

  if (prUrlRecoveredAfterNonzero) {
    result.resultSummary = {
      ...result.resultSummary!,
      status: "done",
    };
    result.artifactManifest = {
      ...result.artifactManifest!,
      status: "done",
      summary: `Runner recovered PR evidence after post-PR no-change failure: ${prUrl}`,
    };
    await writeArtifactManifest(workDir, result.artifactManifest);
  }

  if (isMissingPatchCommand(stdout, stderr)) {
    result.ok = false;
    result.status = "failed";
    result.error = "GitHub patch task reached the default pipeline, but no coding-agent patch command was configured. Configure A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT or A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON and retry.";
  }

  // Collect structured GitHub evidence for propose_patch / github-propose-patch mode.
  const github = await collectGitHubEvidence(config, normalizedTask, result);
  if (github) {
    result.github = github;
    // Backward-compatible: promote to top-level prUrl if github.prUrl is set.
    if (github.prUrl && !result.prUrl) result.prUrl = github.prUrl;
    // Fail closed: GitHub patch tasks must end with PR/Done/Block evidence.
    if (github.outcome === "missing_evidence") {
      result.ok = false;
      result.status = "failed";
      result.error = "GitHub patch task completed without PR/Done/Block evidence. Treating as failed closed until canonical evidence is available.";
      if (result.github.validation) {
        result.github.validation.status = result.status;
      }
    }
    const evidenceHints = buildRunnerEvidenceHints(normalizedTask, result);
    const githubCommentProjection = buildGitHubCommentProjection(normalizedTask, result);
    if (evidenceHints || githubCommentProjection) {
      result.artifactManifest = { ...result.artifactManifest!, ...(evidenceHints ? { evidenceHints } : {}), ...(githubCommentProjection ? { githubCommentProjection } : {}) };
      result.resultSummary = { ...result.resultSummary!, ...(evidenceHints ? { evidenceHints } : {}), ...(githubCommentProjection ? { githubCommentProjection } : {}) };
      await writeArtifactManifest(workDir, result.artifactManifest);
    }
  }

  // ── Execution Proof (Team1 workerAlpha lane, A2A R23) ──────────────────
  // Parent: a2a-docker-runner#261
  // Parent: a2a-plane#335
  const executionProof = buildExecutionProof({
    task: normalizedTask,
    result,
    expanded: expandedTask,
    runToken,
    ...(config.proofSigningKeyFile
      ? {
          signingKeyPem: readFileSync(config.proofSigningKeyFile, "utf8"),
          signingKid: config.proofSigningKid,
        }
      : {}),
  });
  result.executionProof = executionProof;
  result.templateExpansion = templateExpansionEv;
  if (result.artifactManifest) {
    result.artifactManifest = {
      ...result.artifactManifest,
      executionProof,
    };
    await writeArtifactManifest(workDir, result.artifactManifest);
  }

  return result;
}

export async function prepareWorkDirForContainerUser(workDir: string, user?: string): Promise<void> {
  const parsed = parseNumericContainerUser(user);
  if (!parsed) return;

  await chownTreeBestEffort(workDir, parsed.uid, parsed.gid);
}

function requireFullyRedactedSubagentBrief(brief: string): string {
  const runnerRedacted = redactSecrets(brief);
  if (runnerRedacted !== brief) {
    throw new Error("task.subagentContextBrief is not fully redacted at the broker boundary");
  }
  return brief;
}

export function sanitizeSubagentContextBrief<T extends RunnerTask>(task: T): T {
  const brief = task.subagentContextBrief;
  if (typeof brief !== "string" || brief.length === 0) return task;
  if (Buffer.byteLength(brief, "utf8") > 64 * 1024) {
    throw new Error("task.subagentContextBrief exceeds the 65536-byte limit");
  }
  return { ...task, subagentContextBrief: requireFullyRedactedSubagentBrief(brief) };
}

export async function materializeSubagentContextBrief(
  workDir: string,
  task: RunnerTask,
): Promise<string | undefined> {
  const brief = task.subagentContextBrief;
  if (typeof brief !== "string" || brief.length === 0) return undefined;
  if (Buffer.byteLength(brief, "utf8") > 64 * 1024) {
    throw new Error("task.subagentContextBrief exceeds the 65536-byte limit");
  }
  const materializedBrief = requireFullyRedactedSubagentBrief(brief);
  const artifactsDir = join(workDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  const artifactPath = join(artifactsDir, "context-brief.md");
  await writeFile(artifactPath, materializedBrief, { mode: 0o600 });
  return artifactPath;
}

function parseNumericContainerUser(user?: string): { uid: number; gid: number } | undefined {
  const trimmed = user?.trim();
  if (!trimmed || /^(0|root)(?::(?:0|root))?$/i.test(trimmed)) return undefined;

  const [uidText, gidText] = trimmed.split(":", 2);
  if (!/^\d+$/.test(uidText)) return undefined;

  const uid = Number(uidText);
  const gid = gidText === undefined || gidText === "" ? uid : /^\d+$/.test(gidText) ? Number(gidText) : NaN;
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0) return undefined;

  return { uid, gid };
}

async function chownTreeBestEffort(path: string, uid: number, gid: number): Promise<void> {
  try {
    await chown(path, uid, gid);
  } catch {
    await chmod(path, 0o777).catch(() => undefined);
  }

  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await chownTreeBestEffort(child, uid, gid);
      continue;
    }
    await chown(child, uid, gid).catch(async () => {
      await chmod(child, 0o777).catch(() => undefined);
    });
  }
}

function isMissingPatchCommand(stdout: string, stderr: string): boolean {
  return [stdout, stderr]
    .flatMap((text) => text.split(/\r?\n/).map((line) => line.trim()))
    .some((line) => line === "notice=no_patch_command_configured" || line === "error=no_patch_command_configured");
}

export function buildRunnerEvidenceHints(task: NormalizedRunnerTask, result: RunnerResult): RunnerEvidenceHints | undefined {
  const github = result.github;
  const branch = safeHintText(github?.branch ?? result.artifactManifest?.branch);
  const repo = safeGitHubRepoSlug(github?.repo ?? result.artifactManifest?.repo ?? task.repo);
  const failureCategory = inferEvidenceFailureCategory(result);
  const prUrl = canonicalHintPrUrl(result);
  const doneUrl = canonicalHintDoneUrl(result);
  const blockUrl = canonicalHintBlockUrl(result);
  const hint: RunnerEvidenceHints = {
    schemaVersion: "a2a.runner.evidence-hints.v1",
    ...(safeGitHubUrl(task.issueUrl ?? result.artifactManifest?.issueUrl, "issues") ? { issueUrl: task.issueUrl ?? result.artifactManifest?.issueUrl } : {}),
    ...(safeGitHubUrl(github?.startCommentUrl, "issues") ? { startCommentUrl: github?.startCommentUrl } : {}),
    ...(safeGitHubUrl(prUrl, "pull") ? { prUrl } : {}),
    ...(safeGitHubUrl(doneUrl, "issues") ? { doneUrl } : {}),
    ...(safeGitHubUrl(blockUrl, "issues") ? { blockUrl } : {}),
    ...(branch ? { branch } : {}),
    ...(repo && branch ? { branchUrl: buildBranchUrl(repo, branch) } : {}),
    ...(failureCategory ? { failureCategory } : {}),
  };
  return Object.keys(hint).length > 1 ? hint : undefined;
}

function canonicalHintPrUrl(result: RunnerResult): string | undefined {
  const github = result.github;
  if (!github) return result.prUrl ?? result.artifactManifest?.prUrl;
  if (github.outcome === "pr") return github.prUrl ?? result.prUrl ?? result.artifactManifest?.prUrl;
  if (github.outcome) return undefined;
  return github.prUrl ?? result.prUrl ?? result.artifactManifest?.prUrl;
}

function canonicalHintDoneUrl(result: RunnerResult): string | undefined {
  const github = result.github;
  if (!github) return undefined;
  if (github.outcome === "done" || github.outcome === "succeeded_no_changes_with_done_evidence") return github.doneUrl ?? github.doneCommentUrl;
  if (github.outcome) return undefined;
  if (github.prUrl || result.prUrl || result.artifactManifest?.prUrl) return undefined;
  if (github.blockUrl || github.blockCommentUrl) return undefined;
  return github.doneUrl ?? github.doneCommentUrl;
}

function canonicalHintBlockUrl(result: RunnerResult): string | undefined {
  const github = result.github;
  if (!github) return undefined;
  if (github.outcome === "block" || github.outcome === "blocked_no_changes_with_evidence") return github.blockUrl ?? github.blockCommentUrl;
  if (github.outcome) return undefined;
  if (github.prUrl || result.prUrl || result.artifactManifest?.prUrl) return undefined;
  return github.blockUrl ?? github.blockCommentUrl;
}

export function buildGitHubCommentProjection(task: NormalizedRunnerTask, result: RunnerResult): GitHubCommentProjection | undefined {
  const github = result.github;
  const projectionSource = canonicalGitHubCommentProjectionSource(result);
  const kind = projectionSource?.kind;
  const url = projectionSource?.url;
  if (!kind || !url || !safeGitHubUrl(url, kind === "pr" ? "pull" : "issues")) return undefined;
  const projectedUrl = url;

  const issueUrl = safeGitHubUrl(task.issueUrl ?? github?.issueUrl ?? result.artifactManifest?.issueUrl, "issues")
    ? task.issueUrl ?? github?.issueUrl ?? result.artifactManifest?.issueUrl
    : undefined;
  const manifestPath = result.artifactManifest?.manifestPath ?? result.resultSummary?.manifestPath ?? "artifacts/manifest.json";
  const taskId = safeHintText(task.id) ?? "task";
  const dedupeKey = ["a2a-github-comment", taskId, kind, projectedUrl]
    .join(":")
    .replace(/[^A-Za-z0-9_.:/#-]+/g, "_")
    .slice(0, 300);

  return {
    schemaVersion: "a2a.runner.github-comment-projection.v1",
    kind,
    url: projectedUrl,
    ...(issueUrl ? { issueUrl } : {}),
    manifestPath: sanitizeManifestPath(manifestPath),
    dedupeKey,
    commentIsTerminalAck: false,
    commentIsVisibilityReceipt: false,
    commentIsOperatorApproval: false,
  };
}

function canonicalGitHubCommentProjectionSource(result: RunnerResult): { kind: GitHubCommentProjectionKind; url: string } | undefined {
  const blockUrl = canonicalHintBlockUrl(result);
  const doneUrl = canonicalHintDoneUrl(result);
  const prUrl = canonicalHintPrUrl(result);
  if (blockUrl) return { kind: "block", url: blockUrl };
  if (doneUrl) return { kind: "done", url: doneUrl };
  if (prUrl) return { kind: "pr", url: prUrl };
  return undefined;
}

function sanitizeManifestPath(_value: string): string {
  return "artifacts/manifest.json";
}

function inferEvidenceFailureCategory(result: RunnerResult): RunnerEvidenceHints["failureCategory"] | undefined {
  const outcome = result.github?.outcome;
  if (outcome === "succeeded_no_changes_with_done_evidence") return "no_changes_allowed";
  if (outcome === "blocked_no_changes_with_evidence") return outcome;
  if (outcome === "failed_infrastructure") return outcome;
  if (outcome === "block" || outcome === "budget_limited" || outcome === "timed_out" || outcome === "missing_evidence" || outcome === "worker_profile_blocked") return outcome;
  if (result.status === "timeout") return "timed_out";
  if (result.resultSummary?.status === "budget_limited" || result.artifactManifest?.status === "budget_limited") return "budget_limited";
  if (isResourceLimitedFailure(result)) return "resource_limited";
  if (isOpenClawCliUnavailableFailure(result)) return "openclaw_cli_unavailable";
  if (isOpenClawProfileUnavailableFailure(result)) return "openclaw_profile_unavailable";
  if (isOpenClawVersionFailedFailure(result)) return "openclaw_version_failed";
  if (detectEmbeddedModelTimeoutNoFallback(result)) return "embedded_model_timeout_no_fallback";
  if (!result.ok && typeof result.exitCode === "number" && result.exitCode !== 0) return "exit_nonzero";
  if (!result.ok) return "failed";
  return undefined;
}

function isOpenClawCliUnavailableFailure(result: RunnerResult): boolean {
  const text = [
    result.stdout,
    result.stderr,
    result.error,
    result.artifactManifest?.summary,
  ].filter(Boolean).join("\n");
  return /(^|\n)(error=openclaw_install_failed|failure_category=openclaw_cli_unavailable)\b/.test(text);
}

function isOpenClawProfileUnavailableFailure(result: RunnerResult): boolean {
  const text = [
    result.stdout,
    result.stderr,
    result.error,
    result.artifactManifest?.summary,
  ].filter(Boolean).join("\n");
  return /(^|\n)(error=openclaw_config_mount_missing|failure_category=openclaw_profile_unavailable)\b/.test(text);
}

function isOpenClawVersionFailedFailure(result: RunnerResult): boolean {
  const text = [
    result.stdout,
    result.stderr,
    result.error,
    result.artifactManifest?.summary,
  ].filter(Boolean).join("\n");
  return /(^|\n)failure_category=openclaw_version_failed\b/.test(text);
}

function isResourceLimitedFailure(result: RunnerResult): boolean {
  if (result.ok) return false;
  if (result.exitCode === 137 || result.signal === "SIGKILL") return true;
  const text = `${result.resultSummary?.stderr ?? result.stderr ?? ""}\n${result.resultSummary?.stdout ?? result.stdout ?? ""}`;
  return /(?:oomkilled|out of memory|cannot allocate memory|allocation failed|heap limit allocation failed|javaScript heap out of memory|no space left on device|\bENOSPC\b|resource temporarily unavailable|Killed)$/im.test(text);
}

function buildBranchUrl(repo: string, branch: string): string {
  return "https://github.com/" + repo + "/tree/" + branch.split("/").map(encodeURIComponent).join("/");
}

function safeGitHubRepoSlug(value: string | undefined): string | undefined {
  if (!value || hasUnsafeHintContent(value)) return undefined;
  const slugPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if (slugPattern.test(value)) return value;
  const match = value.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  return match?.[1] && slugPattern.test(match[1]) ? match[1] : undefined;
}

function safeGitHubUrl(value: string | undefined, kind: "issues" | "pull"): boolean {
  if (!value || hasUnsafeHintContent(value)) return false;
  try {
    const url = new URL(value);
    const urlPattern = new RegExp("^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/" + kind + "/\\d+(?:#issuecomment-\\d+)?$");
    return url.protocol === "https:" && url.hostname === "github.com" && urlPattern.test(url.pathname + url.hash);
  } catch {
    return false;
  }
}

function safeHintText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const safe = redactAndBound(value.replace(/[\r\n]+/g, " ").trim(), 160);
  if (!safe || hasUnsafeHintContent(safe)) return undefined;
  return safe;
}

function hasUnsafeHintContent(value: string): boolean {
  return /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|Authorization:\s*(?:Bearer|token)|\/root\/|\/home\/|\/tmp\/|\/var\/folders\/|token=|password=|secret=|api[_-]?key=)/i.test(value);
}

function validateTask(task: RunnerTask): void {
  if (!task.id) throw new Error("task.id is required");
  if (!task.intent) throw new Error("task.intent is required");
}

/**
 * Build a deterministic block RunnerResult for non-Docker workerProfile tasks.
 *
 * Called from runTask when the task carries a Hermes/native A2A worker profile
 * such as "termux-hermes", "external-harness", or "hermes".  Returns a result
 * with github.outcome = "worker_profile_blocked" so the broker sees a clean
 * Block outcome and can re-route the task.
 *
 * Parent: a2a-docker-runner#340
 * Parent: a2a-plane#464
 */
function buildWorkerProfileBlockResult(
  task: RunnerTask,
  workerProfile: string,
  blockError: string,
): RunnerResult {
  const normalizedTask = normalizeTask(task);
  const repo = normalizedTask.repos[0]?.url ?? task.repo ?? "";
  const blockMessage = `blocked: ${blockError}`;
  return {
    ok: false,
    taskId: task.id,
    status: "failed",
    workDir: "",
    exitCode: 4,
    signal: null,
    stdout: blockMessage,
    stderr: `worker_profile=${workerProfile}\n`,
    artifacts: [],
    error: blockError,
    github: {
      schemaVersion: "a2a.runner.github-evidence.v1",
      repo,
      issue: task.issue ? (typeof task.issue === "number" ? `#${task.issue}` : String(task.issue)) : undefined,
      issueUrl: task.issueUrl,
      taskId: task.id,
      outcome: "worker_profile_blocked",
      validation: {
        status: "failed",
        exitCode: 4,
        signal: null,
        timedOut: false,
        artifactCount: 0,
      },
      safetyState: {
        noLiveProviderSend: true,
        terminalAck: "not_attempted",
        providerSendIsReceiptEvidence: false,
      },
    },
  };
}

function safeId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^[-.]+/, "_").slice(0, 80);
  return safe || "task";
}

function createRunToken(): string {
  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]/g, "").slice(0, 15);
  const random = Math.random().toString(36).slice(2, 10);
  return `${stamp}-${process.pid.toString(36)}-${random}`;
}

function buildContainerName(taskId: string, runToken: string): string {
  return `a2a-${safeId(taskId)}-${runToken}`.slice(0, 128);
}

export function buildRunArgs(config: RunnerConfig, task: RunnerTask, workDir: string, runToken = createRunToken()): string[] {
  const containerName = buildContainerName(task.id, runToken);
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    config.network ?? "bridge",
    "--label",
    `a2a.task.id=${safeId(task.id)}`,
    "--label",
    `a2a.run.id=${runToken}`,
    "--memory",
    config.memory ?? "2g",
    "--cpus",
    config.cpus ?? "2",
    "--pids-limit",
    config.pidsLimit ?? "512",
    "-v",
    `${workDir}:/work`,
    "-w",
    "/work",
  ];

  // Task containers run arbitrary task commands with a GitHub token mounted;
  // setuid escalation inside the container buys an attacker nothing extra.
  if (config.noNewPrivileges !== false) {
    args.push("--security-opt", "no-new-privileges");
  }
  if (config.readOnlyRootFilesystem === true) {
    args.push("--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m");
  }
  if (config.user) {
    args.push("--user", config.user);
  }
  for (const cap of config.capDrop ?? []) {
    args.push("--cap-drop", cap);
  }
  for (const cap of config.capAdd ?? []) {
    args.push("--cap-add", cap);
  }

  if (config.githubTokenFile && config.trustedOperator) {
    args.push("-v", `${config.githubTokenFile}:/run/secrets/gh-hosts.yml:ro`);
    args.push("-e", "GH_CONFIG_HOSTS=/run/secrets/gh-hosts.yml");
  }

  // Distributed-trace propagation: surface the task trace id to the in-
  // container work and as a label so a container can be correlated back to
  // the originating A2A request.
  const rawTraceId = typeof task.traceId === "string" ? task.traceId.trim() : "";
  const traceId =
    rawTraceId && rawTraceId.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(rawTraceId) ? rawTraceId : "";
  if (traceId) {
    args.push("-e", `A2A_TRACE_ID=${traceId}`);
    args.push("--label", `a2a.trace.id=${safeId(traceId)}`);
  }

  // Contained-subagent conductor directive: the in-container agent harness is
  // the orchestra conductor for its own task — simple work is done directly,
  // heavy work may fan out to at most maxCount (hard cap 4) evidence-only
  // helpers. The config existed but was never advertised to the container;
  // without these env vars the in-container harness had no budget to honor.
  if (config.containedSubagents?.enabled) {
    args.push("-e", "A2A_CONTAINED_SUBAGENTS_ENABLED=1");
    args.push("-e", `A2A_CONTAINED_SUBAGENTS_MAX=${config.containedSubagents.maxCount}`);
    args.push("-e", `A2A_CONTAINED_SUBAGENTS_ROLES=${config.containedSubagents.roles.join(",")}`);
    args.push("-e", `A2A_CONTAINED_SUBAGENTS_OUTPUT_BYTES=${config.containedSubagents.outputBytes}`);
    args.push("-e", `A2A_CONTAINED_SUBAGENTS_REASONS=${config.containedSubagents.reasons.join(",")}`);
    if (typeof task.subagentContextBrief === "string" && task.subagentContextBrief.length > 0) {
      args.push("-e", "A2A_SUBAGENT_CONTEXT_BRIEF=/work/artifacts/context-brief.md");
    }
  }

  for (const mount of config.extraMounts ?? []) {
    const mode = mount.readOnly === false ? "rw" : "ro";
    args.push("-v", `${mount.source}:${mount.target}:${mode}`);
  }

  // Safe patch command paths are mutually exclusive by priority:
  // commandScript > commandJson > commandTemplate (legacy eval).
  // commandScript is mounted as /work/patch-command.sh, so it needs no env var.
  if (config.commandScript) {
    // no-op: runTask writes /work/patch-command.sh
  } else if (config.commandJson) {
    args.push("-e", `A2A_PATCH_COMMAND_JSON=${config.commandJson}`);
  } else if (config.commandTemplate) {
    args.push("-e", `A2A_PATCH_COMMAND=${config.commandTemplate}`);
  }

  for (const [key, value] of Object.entries(buildMetadataEnv(config))) {
    args.push("-e", `${key}=${value}`);
  }

  // Reserved conductor keys are policy-controlled: a task-supplied env must
  // never override the opt-in flag or the hard-cap budget injected above.
  const reservedSubagentEnv = new Set([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_CONFIG_HOSTS",
    "GH_CONFIG_DIR",
    "GIT_ASKPASS",
    "GIT_TERMINAL_PROMPT",
    "A2A_CONTAINED_SUBAGENTS_ENABLED",
    "A2A_CONTAINED_SUBAGENTS_MAX",
    "A2A_CONTAINED_SUBAGENTS_ROLES",
    "A2A_CONTAINED_SUBAGENTS_OUTPUT_BYTES",
    "A2A_CONTAINED_SUBAGENTS_REASONS",
    "A2A_SUBAGENT_CONTEXT_BRIEF",
  ]);
  for (const [key, value] of Object.entries(task.env ?? {})) {
    if (reservedSubagentEnv.has(key)) continue;
    args.push("-e", `${key}=${value}`);
  }

  args.push(config.image, "bash", "/work/run.sh");
  return args;
}

function buildMetadataEnv(config: RunnerConfig): Record<string, string> {
  const build = config.buildMetadata;
  if (!build) return {};
  return Object.fromEntries(Object.entries({
    A2A_RUNNER_BUILD_VERSION: build.version,
    A2A_RUNNER_BUILD_SOURCE: build.source,
    A2A_RUNNER_BUILD_REVISION: build.revision,
    A2A_RUNNER_BUILD_BUILT_AT: build.builtAt,
    A2A_RUNNER_BUILD_IMAGE: build.image,
  }).filter(([, value]) => typeof value === "string" && value.length > 0)) as Record<string, string>;
}

export function sanitizeTaskArtifactPayload(value: unknown, fieldName?: string): unknown {
  if (isSensitiveFieldName(fieldName)) return "<redacted>";
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeTaskArtifactPayload(entry, fieldName));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      sanitizeTaskArtifactPayload(entry, key),
    ]),
  );
}

function isSensitiveFieldName(fieldName: string | undefined): boolean {
  return Boolean(fieldName && /(?:token|password|secret|api[_-]?key|authorization|credential|oauth)/i.test(fieldName));
}

async function writeSanitizedTaskArtifact(workDir: string, task: NormalizedRunnerTask): Promise<void> {
  await mkdir(join(workDir, "artifacts"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(workDir, "artifacts", "task.json"),
    `${JSON.stringify(sanitizeTaskArtifactPayload(task), null, 2)}\n`,
  );
}

export function buildResultSummary(
  completed: SpawnResult,
  stdout: string,
  stderr: string,
  artifacts: string[],
  manifest: ArtifactManifest,
  runnerBuild?: RunnerConfig["buildMetadata"],
): ResultSummary {
  return {
    exitCode: completed.code,
    signal: completed.signal,
    timedOut: completed.timedOut,
    stdout,
    stderr,
    stdoutTruncated: stdout.includes("\n<truncated "),
    stderrTruncated: stderr.includes("\n<truncated "),
    artifactCount: artifacts.length,
    manifestPath: manifest.manifestPath,
    status: manifest.status,
    ...(manifest.budget ? { budget: manifest.budget } : {}),
    ...(manifest.receiptTrace ? { receiptTrace: manifest.receiptTrace } : {}),
    ...(manifest.continuation ? { continuation: manifest.continuation } : {}),
    ...(manifest.cleanupRehearsal ? { cleanupRehearsal: manifest.cleanupRehearsal } : {}),
    ...(manifest.evidenceHints ? { evidenceHints: manifest.evidenceHints } : {}),
    ...(manifest.githubCommentProjection ? { githubCommentProjection: manifest.githubCommentProjection } : {}),
    ...(manifest.sourcePublicApprovalRehearsal ? { sourcePublicApprovalRehearsal: manifest.sourcePublicApprovalRehearsal } : {}),
    ...(manifest.sourcePublicExecutionPreflight ? { sourcePublicExecutionPreflight: manifest.sourcePublicExecutionPreflight } : {}),
    ...(manifest.postPatchVerification ? { postPatchVerification: manifest.postPatchVerification } : {}),
    ...(manifest.diffHygiene ? { diffHygiene: manifest.diffHygiene } : {}),
    ...(manifest.reproducibility ? { reproducibility: manifest.reproducibility } : {}),
    ...(runnerBuild ? { runnerBuild } : {}),
  };
}

async function readArtifactJson<T>(workDir: string, artifactName: string, guard: (value: unknown) => value is T): Promise<T | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(workDir, "artifacts", artifactName), "utf8"));
    return guard(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPostPatchVerificationEvidence(value: unknown): value is RunnerPostPatchVerificationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return entry.schemaVersion === "a2a.runner.post-patch-verification.v1"
    && Array.isArray(entry.command)
    && entry.command.every((part) => typeof part === "string")
    && typeof entry.exitCode === "number"
    && typeof entry.expectedExitCode === "number"
    && entry.logPath === "artifacts/post-patch-verification.log"
    && (entry.status === "passed" || entry.status === "failed")
    && isPostPatchVerificationBaselineEvidence(entry.baseline);
}

function isPostPatchVerificationBaselineEvidence(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (entry.mode === "record" || entry.mode === "require-red")
    && typeof entry.exitCode === "number"
    && typeof entry.metExpectation === "boolean"
    && (entry.durationMs === undefined || (Number.isInteger(entry.durationMs) && (entry.durationMs as number) >= 0))
    && (entry.logSha256 === undefined || (typeof entry.logSha256 === "string" && /^[a-f0-9]{64}$/.test(entry.logSha256)))
    && entry.logPath === "artifacts/post-patch-verification-baseline.log"
    && (entry.verdict === "recorded" || entry.verdict === "vacuous");
}

function isDiffHygieneEvidence(value: unknown): value is RunnerDiffHygieneEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return entry.schemaVersion === "a2a.runner.diff-hygiene.v1"
    && (entry.status === "passed" || entry.status === "blocked")
    && Array.isArray(entry.changedPaths)
    && entry.changedPaths.every((part) => typeof part === "string")
    && Array.isArray(entry.blockedPaths)
    && entry.blockedPaths.every((part) => typeof part === "string")
    && Array.isArray(entry.lockfileChanges)
    && entry.lockfileChanges.every((part) => typeof part === "string")
    && typeof entry.whitespaceOnly === "boolean"
    && isDiffHygieneChurn(entry.churn)
    && isDiffHygieneScopeDrift(entry.scopeDrift);
}

function isDiffHygieneScopeDrift(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scopeDrift = value as Record<string, unknown>;
  return Array.isArray(scopeDrift.declared)
    && scopeDrift.declared.every((part) => typeof part === "string")
    && Array.isArray(scopeDrift.outside)
    && scopeDrift.outside.every((part) => typeof part === "string")
    && (scopeDrift.level === "ok" || scopeDrift.level === "warn" || scopeDrift.level === "block");
}

function isDiffHygieneChurn(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const churn = value as Record<string, unknown>;
  return Number.isInteger(churn.totalLines) && (churn.totalLines as number) >= 0
    && Number.isInteger(churn.whitespaceLines) && (churn.whitespaceLines as number) >= 0
    && typeof churn.ratio === "number" && churn.ratio >= 0 && churn.ratio <= 1
    && (churn.level === "none" || churn.level === "warn" || churn.level === "block");
}

async function buildReproducibilityMetadata(config: RunnerConfig, task: NormalizedRunnerTask, workDir: string): Promise<RunnerReproducibilityMetadata> {
  const primaryRepo = task.repos.find((repo) => repo.primary) ?? task.repos[0];
  const lockfileSha256 = primaryRepo ? await hashFirstExisting([
    join(workDir, primaryRepo.path ?? "repo", "package-lock.json"),
    join(workDir, primaryRepo.path ?? "repo", "pnpm-lock.yaml"),
    join(workDir, primaryRepo.path ?? "repo", "yarn.lock"),
  ]) : undefined;
  return {
    schemaVersion: "a2a.runner.reproducibility.v1",
    image: config.image,
    nodeVersion: process.version,
    ...(config.buildMetadata?.revision ? { runnerRevision: config.buildMetadata.revision } : {}),
    ...(lockfileSha256 ? { lockfileSha256 } : {}),
    envProfile: {
      network: config.network ?? "bridge",
      readOnlyRootFilesystem: config.readOnlyRootFilesystem === true,
      trustedOperator: config.trustedOperator === true,
    },
  };
}

async function hashFirstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      return createHash("sha256").update(await readFile(path)).digest("hex");
    } catch {
      // try next lockfile
    }
  }
  return undefined;
}

export interface ArtifactManifestContext {
  task?: NormalizedRunnerTask;
  status?: ArtifactManifestStatus;
  stdout?: string;
  stderr?: string;
  prUrl?: string;
  budget?: RunnerBudgetEvidence;
  receiptTrace?: RunnerReceiptTrace;
  continuation?: RunnerContinuationEvidence;
  postPatchVerification?: RunnerPostPatchVerificationEvidence;
  diffHygiene?: RunnerDiffHygieneEvidence;
  reproducibility?: RunnerReproducibilityMetadata;
  cleanupRehearsal?: CleanupRehearsalEvidence;
  evidenceHints?: RunnerEvidenceHints;
  githubCommentProjection?: GitHubCommentProjection;
  sourcePublicApprovalRehearsal?: SourcePublicApprovalRehearsal;
  sourcePublicExecutionPreflight?: SourcePublicExecutionPreflight;
}

export async function buildArtifactManifest(workDir: string, artifacts: string[], context: ArtifactManifestContext = {}): Promise<ArtifactManifest> {
  const entries: ArtifactManifestEntry[] = [];
  for (const artifact of artifacts) {
    const info = await stat(artifact);
    entries.push({
      path: relative(workDir, artifact).split("/").join("/"),
      name: basename(artifact),
      sizeBytes: info.size,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const evidence = await buildArtifactEvidenceParts(workDir, entries, context.status);
  const task = context.task;
  const primaryRepo = task?.repos.find((repo) => repo.primary) ?? task?.repos[0];
  const summary = buildArtifactManifestSummary(context, evidence.length);
  const sourcePublicApprovalRehearsal = sanitizeSourcePublicApprovalRehearsal(context.sourcePublicApprovalRehearsal);
  const sourcePublicExecutionPreflight = sanitizeSourcePublicExecutionPreflight(context.sourcePublicExecutionPreflight);
  const cleanupRehearsal = sanitizeCleanupRehearsal(context.cleanupRehearsal);
  return {
    artifactVersion: 1,
    schemaVersion: 1,
    manifestPath: "artifacts/manifest.json",
    generatedAt: "1970-01-01T00:00:00.000Z",
    ...(task?.id ? { taskId: task.id } : {}),
    ...(primaryRepo?.url ? { repo: primaryRepo.url } : task?.repo ? { repo: task.repo } : {}),
    ...(primaryRepo?.branch ?? task?.baseBranch ? { branch: primaryRepo?.branch ?? task?.baseBranch } : {}),
    ...(context.prUrl ? { prUrl: context.prUrl } : {}),
    ...(task?.issueUrl ? { issueUrl: task.issueUrl } : {}),
    status: context.status ?? "done",
    summary,
    evidence,
    artifacts: entries,
    ...(context.budget ? { budget: context.budget } : {}),
    ...(context.receiptTrace ? { receiptTrace: context.receiptTrace } : {}),
    ...(context.continuation ? { continuation: context.continuation } : {}),
    ...(context.postPatchVerification ? { postPatchVerification: context.postPatchVerification } : {}),
    ...(context.diffHygiene ? { diffHygiene: context.diffHygiene } : {}),
    ...(context.reproducibility ? { reproducibility: context.reproducibility } : {}),
    ...(cleanupRehearsal ? { cleanupRehearsal } : {}),
    ...(context.evidenceHints ? { evidenceHints: context.evidenceHints } : {}),
    ...(context.githubCommentProjection ? { githubCommentProjection: context.githubCommentProjection } : {}),
    ...(sourcePublicApprovalRehearsal ? { sourcePublicApprovalRehearsal } : {}),
    ...(sourcePublicExecutionPreflight ? { sourcePublicExecutionPreflight } : {}),
  };
}

function inferBudgetStopEvidence(stdout: string, stderr: string): Pick<ArtifactManifestContext, "budget" | "continuation"> | undefined {
  const text = `${stdout}\n${stderr}`;
  if (!/(?:^|\n)(?:status=budget_limited|budget_limited\b)/i.test(text)) return undefined;

  const limitKind = extractBudgetField(text, "limitKind");
  const limit = safeBudgetText(extractBudgetField(text, "limit"));
  const used = safeBudgetText(extractBudgetField(text, "used"));
  const reason = safeBudgetText(extractBudgetField(text, "reason"));
  const budget: RunnerBudgetEvidence = {
    limitKind: isRunnerBudgetLimitKind(limitKind) ? limitKind : "time",
    ...(limit ? { limit } : {}),
    ...(used ? { used } : {}),
    ...(reason ? { reason } : {}),
  };
  const nextPrompt = safeBudgetText(extractBudgetField(text, "nextPrompt"), 300);
  return {
    budget,
    continuation: {
      recommended: true,
      requiresApproval: true,
      ...(nextPrompt ? { nextPrompt } : {}),
    },
  };
}

function parseReceiptTraceEnv(env: Record<string, string> | undefined): unknown {
  const raw = env?.A2A_RUNNER_RECEIPT_TRACE ?? env?.A2A_RECEIPT_TRACE;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return { status: "failed", reason: "invalid receipt trace metadata" };
  }
}

export function sanitizeCleanupRehearsal(input: unknown): CleanupRehearsalEvidence | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== "a2a.runner.cleanup-rehearsal.v1") return undefined;
  if (value.generatedAt !== "1970-01-01T00:00:00.000Z") return undefined;
  if (!isCleanupRehearsalTarget(value.target) || !isCleanupRehearsalMode(value.mode) || !isCleanupRehearsalStatus(value.status)) return undefined;

  const planId = safeBudgetText(typeof value.planId === "string" ? value.planId : undefined, 120);
  const runId = safeBudgetText(typeof value.runId === "string" ? value.runId : undefined, 160);
  const candidateCounts = sanitizeCleanupCandidateCounts(value.candidateCounts);
  const checkpoint = sanitizeCleanupCheckpoint(value.checkpoint);
  const rollback = sanitizeCleanupRollback(value.rollback);
  const safetyGates = value.safetyGates as Record<string, unknown> | undefined;
  if (!planId || !candidateCounts || !checkpoint || !rollback || !hasSafeCleanupRehearsalGates(safetyGates)) return undefined;

  const failClosedReasons = Array.isArray(value.failClosedReasons)
    ? value.failClosedReasons
      .filter((reason): reason is string => typeof reason === "string")
      .map((reason) => safeBudgetText(reason, 220))
      .filter((reason): reason is string => Boolean(reason))
      .slice(0, 10)
    : [];

  return {
    schemaVersion: "a2a.runner.cleanup-rehearsal.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    ...(runId ? { runId } : {}),
    target: value.target,
    mode: value.mode,
    status: value.status,
    planId,
    candidateCounts,
    checkpoint,
    rollback,
    failClosedReasons,
    safetyGates: {
      explicitOperatorApprovalRequired: true,
      backupCheckpointRequired: true,
      dryRunOnly: true,
      liveExecutionBlocked: true,
      dbMutationPerformed: false,
      prunePerformed: false,
      migrationPerformed: false,
      deployOrRestartPerformed: false,
      liveProviderSendPerformed: false,
      terminalAckSent: false,
    },
  };
}

function isCleanupRehearsalTarget(value: unknown): value is CleanupRehearsalEvidence["target"] {
  return value === "broker_db" || value === "runner_artifacts";
}

function isCleanupRehearsalMode(value: unknown): value is CleanupRehearsalEvidence["mode"] {
  return value === "dry_run" || value === "simulate";
}

function isCleanupRehearsalStatus(value: unknown): value is CleanupRehearsalEvidence["status"] {
  return value === "ready_for_operator_approval" || value === "blocked";
}

function sanitizeCleanupCandidateCounts(input: unknown): CleanupRehearsalEvidence["candidateCounts"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const total = safeNonNegativeInt(value.total);
  const highRisk = safeNonNegativeInt(value.highRisk);
  if (total === undefined || highRisk === undefined) return undefined;
  const counts: CleanupRehearsalEvidence["candidateCounts"] = { total, highRisk };
  for (const key of ["staleWorkerRows", "terminalOutboxRows", "artifactDirs"] as const) {
    const count = safeNonNegativeInt(value[key]);
    if (count !== undefined) counts[key] = count;
  }
  return counts;
}

function sanitizeCleanupCheckpoint(input: unknown): CleanupRehearsalEvidence["checkpoint"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (value.requiredBeforeExecution !== true || value.rehearsalOnly !== true || value.evidenceBundlePath !== "artifacts/manifest.json" || value.backupVerified !== false) return undefined;
  const checkpointId = safeBudgetText(typeof value.checkpointId === "string" ? value.checkpointId : undefined, 120);
  if (!checkpointId) return undefined;
  return {
    requiredBeforeExecution: true,
    rehearsalOnly: true,
    evidenceBundlePath: "artifacts/manifest.json",
    checkpointId,
    backupVerified: false,
  };
}

function sanitizeCleanupRollback(input: unknown): CleanupRehearsalEvidence["rollback"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (value.rehearsed !== true || value.restoreVerificationRequired !== true) return undefined;
  const rollbackPlanPath = safeRehearsalPath(typeof value.rollbackPlanPath === "string" ? value.rollbackPlanPath : undefined);
  const abortPlanPath = safeRehearsalPath(typeof value.abortPlanPath === "string" ? value.abortPlanPath : undefined);
  if (!rollbackPlanPath || !abortPlanPath) return undefined;
  return { rehearsed: true, rollbackPlanPath, abortPlanPath, restoreVerificationRequired: true };
}

function hasSafeCleanupRehearsalGates(value: Record<string, unknown> | undefined): boolean {
  return value?.explicitOperatorApprovalRequired === true
    && value.backupCheckpointRequired === true
    && value.dryRunOnly === true
    && value.liveExecutionBlocked === true
    && value.dbMutationPerformed === false
    && value.prunePerformed === false
    && value.migrationPerformed === false
    && value.deployOrRestartPerformed === false
    && value.liveProviderSendPerformed === false
    && value.terminalAckSent === false;
}

function safeNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export interface SourcePublicApprovalRehearsalInput {
  targetRepo: string;
  decision?: SourcePublicApprovalDecision;
  runId?: string;
  packetId?: string;
  dedupeKey?: string;
  rollbackPath?: string;
  abortPath?: string;
}

export function buildSourcePublicApprovalRehearsal(input: SourcePublicApprovalRehearsalInput): SourcePublicApprovalRehearsal {
  const targetRepo = safeSourcePublicRepo(input.targetRepo);
  if (!targetRepo) throw new Error("source-public rehearsal targetRepo must be owner/repo");
  const decision = input.decision ?? "NEEDS_OPERATOR_APPROVAL";
  const packetId = safeBudgetText(input.packetId ?? `source-public-${targetRepo.replace("/", "-")}`, 120);
  const dedupeKey = safeBudgetText(input.dedupeKey ?? `source-public:${targetRepo}:${packetId}:${decision}`, 240);
  const rollbackPath = safeRehearsalPath(input.rollbackPath ?? "rollback/source-public-approval-rehearsal.md");
  const abortPath = safeRehearsalPath(input.abortPath ?? "abort/source-public-approval-rehearsal.md");
  if (!isSourcePublicDecision(decision) || !packetId || !dedupeKey || !rollbackPath || !abortPath) {
    throw new Error("invalid source-public approval rehearsal input");
  }
  const rehearsal = sanitizeSourcePublicApprovalRehearsal({
    schemaVersion: "a2a.runner.source-public-approval-rehearsal.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    ...(input.runId ? { runId: input.runId } : {}),
    decision,
    terminalBriefRehearsalOnly: true,
    approvalPackets: [{
      schemaVersion: "a2a.runner.source-public-approval-packet.v1",
      packetId,
      targetRepo,
      decision,
      dedupeKey,
      evidenceBundlePath: "artifacts/manifest.json",
      operatorApprovalRequired: true,
      approvalExecuted: false,
      releaseExecuted: false,
      visibilityChanged: false,
      terminalAckSent: false,
      providerSendPerformed: false,
      dbMutationPerformed: false,
      rollbackPath,
      abortPath,
    }],
    replayNoDuplicateProof: { dedupeKey, noDuplicatePacketIds: true },
    rollbackAbort: { rollbackPath, abortPath },
    safetyGates: {
      operatorApprovalRequired: true,
      sourcePublicExecutionBlocked: true,
      approvalExecuted: false,
      releaseExecuted: false,
      visibilityChanged: false,
      liveProviderSendPerformed: false,
      terminalAckSent: false,
      dbMutationPerformed: false,
    },
  });
  if (!rehearsal) throw new Error("failed to build source-public approval rehearsal");
  return rehearsal;
}

export function sanitizeSourcePublicApprovalRehearsal(input: unknown): SourcePublicApprovalRehearsal | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== "a2a.runner.source-public-approval-rehearsal.v1") return undefined;
  if (value.generatedAt !== "1970-01-01T00:00:00.000Z") return undefined;
  if (!isSourcePublicDecision(value.decision)) return undefined;
  if (value.terminalBriefRehearsalOnly !== true) return undefined;
  const packets = Array.isArray(value.approvalPackets)
    ? value.approvalPackets.map(sanitizeSourcePublicApprovalPacket).filter((packet): packet is SourcePublicApprovalPacket => Boolean(packet))
    : [];
  if (packets.length === 0 || packets.length > 10) return undefined;
  const packetIds = new Set(packets.map((packet) => packet.packetId));
  if (packetIds.size !== packets.length) return undefined;
  const replay = value.replayNoDuplicateProof as Record<string, unknown> | undefined;
  const rollbackAbort = value.rollbackAbort as Record<string, unknown> | undefined;
  const safetyGates = value.safetyGates as Record<string, unknown> | undefined;
  if (replay?.noDuplicatePacketIds !== true) return undefined;
  if (!hasSafeSourcePublicGates(safetyGates)) return undefined;
  const dedupeKey = safeBudgetText(typeof replay?.dedupeKey === "string" ? replay.dedupeKey : undefined, 240);
  const rollbackPath = safeRehearsalPath(typeof rollbackAbort?.rollbackPath === "string" ? rollbackAbort.rollbackPath : undefined);
  const abortPath = safeRehearsalPath(typeof rollbackAbort?.abortPath === "string" ? rollbackAbort.abortPath : undefined);
  if (!dedupeKey || !rollbackPath || !abortPath) return undefined;
  return {
    schemaVersion: "a2a.runner.source-public-approval-rehearsal.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    ...(typeof value.runId === "string" && safeBudgetText(value.runId, 160) ? { runId: safeBudgetText(value.runId, 160) } : {}),
    decision: value.decision,
    approvalPackets: packets.sort((a, b) => a.packetId.localeCompare(b.packetId)),
    terminalBriefRehearsalOnly: true,
    replayNoDuplicateProof: { dedupeKey, noDuplicatePacketIds: true },
    rollbackAbort: { rollbackPath, abortPath },
    safetyGates: {
      operatorApprovalRequired: true,
      sourcePublicExecutionBlocked: true,
      approvalExecuted: false,
      releaseExecuted: false,
      visibilityChanged: false,
      liveProviderSendPerformed: false,
      terminalAckSent: false,
      dbMutationPerformed: false,
    },
  };
}

function sanitizeSourcePublicApprovalPacket(input: unknown): SourcePublicApprovalPacket | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== "a2a.runner.source-public-approval-packet.v1") return undefined;
  if (!isSourcePublicDecision(value.decision)) return undefined;
  if (value.evidenceBundlePath !== "artifacts/manifest.json") return undefined;
  if (value.operatorApprovalRequired !== true || value.approvalExecuted !== false || value.releaseExecuted !== false || value.visibilityChanged !== false || value.terminalAckSent !== false || value.providerSendPerformed !== false || value.dbMutationPerformed !== false) return undefined;
  const packetId = safeBudgetText(typeof value.packetId === "string" ? value.packetId : undefined, 120);
  const targetRepo = safeSourcePublicRepo(typeof value.targetRepo === "string" ? value.targetRepo : undefined);
  const dedupeKey = safeBudgetText(typeof value.dedupeKey === "string" ? value.dedupeKey : undefined, 240);
  const rollbackPath = safeRehearsalPath(typeof value.rollbackPath === "string" ? value.rollbackPath : undefined);
  const abortPath = safeRehearsalPath(typeof value.abortPath === "string" ? value.abortPath : undefined);
  if (!packetId || !targetRepo || !dedupeKey || !rollbackPath || !abortPath) return undefined;
  return {
    schemaVersion: "a2a.runner.source-public-approval-packet.v1",
    packetId,
    targetRepo,
    decision: value.decision,
    dedupeKey,
    evidenceBundlePath: "artifacts/manifest.json",
    operatorApprovalRequired: true,
    approvalExecuted: false,
    releaseExecuted: false,
    visibilityChanged: false,
    terminalAckSent: false,
    providerSendPerformed: false,
    dbMutationPerformed: false,
    rollbackPath,
    abortPath,
  };
}

function isSourcePublicDecision(value: unknown): value is SourcePublicApprovalDecision {
  return value === "GO_CANDIDATE" || value === "NO_GO" || value === "NEEDS_OPERATOR_APPROVAL";
}

function hasSafeSourcePublicGates(value: Record<string, unknown> | undefined): boolean {
  return value?.operatorApprovalRequired === true
    && value.sourcePublicExecutionBlocked === true
    && value.approvalExecuted === false
    && value.releaseExecuted === false
    && value.visibilityChanged === false
    && value.liveProviderSendPerformed === false
    && value.terminalAckSent === false
    && value.dbMutationPerformed === false;
}

function safeSourcePublicRepo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const safe = safeBudgetText(value, 160);
  return safe && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(safe) ? safe : undefined;
}

function safeRehearsalPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const safe = safeBudgetText(value, 160);
  if (!safe || safe.includes("..") || safe.startsWith("/") || /^~(?:\/|$)/.test(safe)) return undefined;
  return safe;
}

export function sanitizeReceiptTrace(input: unknown): RunnerReceiptTrace | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const trace: RunnerReceiptTrace = { schemaVersion: "a2a.runner.receipt-trace.v1" };
  copyReceiptText(trace, value, "outboxId", 160);
  copyReceiptText(trace, value, "notificationId", 160);
  copyReceiptText(trace, value, "dedupeKey", 240);
  copyReceiptText(trace, value, "channel", 60);
  copyReceiptText(trace, value, "receiptId", 160);
  copyReceiptText(trace, value, "acknowledgedAt", 80);
  copyReceiptText(trace, value, "updatedAt", 80);
  copyReceiptText(trace, value, "reason", 300);

  const status = typeof value.status === "string" ? value.status : undefined;
  if (isReceiptTraceStatus(status)) trace.status = status;
  const evidence = typeof value.evidence === "string" ? value.evidence : undefined;
  if (isReceiptEvidence(evidence)) trace.evidence = evidence;
  if (typeof value.attemptCount === "number" && Number.isInteger(value.attemptCount) && value.attemptCount >= 0) trace.attemptCount = value.attemptCount;
  if (typeof value.staleAfterMs === "number" && Number.isFinite(value.staleAfterMs) && value.staleAfterMs >= 0) trace.staleAfterMs = Math.floor(value.staleAfterMs);

  return Object.keys(trace).length > 1 ? trace : undefined;
}

function copyReceiptText(target: RunnerReceiptTrace, source: Record<string, unknown>, key: keyof RunnerReceiptTrace, limit: number): void {
  const value = source[key];
  if (typeof value !== "string") return;
  const safe = safeBudgetText(value, limit);
  if (safe) Object.assign(target, { [key]: safe });
}

function isReceiptTraceStatus(value: string | undefined): value is NonNullable<RunnerReceiptTrace["status"]> {
  return value === "pending"
    || value === "accepted"
    || value === "started"
    || value === "produced"
    || value === "provider_sent"
    || value === "operator_visible"
    || value === "operator_confirmed"
    || value === "provider_delivery_receipt"
    || value === "timed_out"
    || value === "stale"
    || value === "failed"
    || value === "receipt_confirmed";
}

function isReceiptEvidence(value: string | undefined): value is NonNullable<RunnerReceiptTrace["evidence"]> {
  return value === "operator_visible" || value === "operator_confirmed" || value === "provider_delivery_receipt";
}

function extractBudgetField(text: string, field: "limitKind" | "limit" | "used" | "reason" | "nextPrompt"): string | undefined {
  const aliases: Record<typeof field, string[]> = {
    limitKind: ["budget.limitKind", "budget_limit_kind"],
    limit: ["budget.limit", "budget_limit"],
    used: ["budget.used", "budget_used"],
    reason: ["budget.reason", "budget_reason"],
    nextPrompt: ["continuation.nextPrompt", "continuation_next_prompt"],
  };
  for (const alias of aliases[field]) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`(?:^|\\n)${escaped}=([^\\r\\n]+)`, "i"));
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function isRunnerBudgetLimitKind(value: string | undefined): value is RunnerBudgetEvidence["limitKind"] {
  return value === "time" || value === "token" || value === "attempt" || value === "command" || value === "safety";
}

function safeBudgetText(value: string | undefined, limit = 160): string | undefined {
  if (!value) return undefined;
  const safe = redactAndBound(value.replace(/[\r\n]+/g, " ").trim(), limit);
  return safe || undefined;
}

async function buildArtifactEvidenceParts(
  workDir: string,
  entries: ArtifactManifestEntry[],
  runStatus: ArtifactManifestStatus = "done",
): Promise<ArtifactEvidencePart[]> {
  const parts: ArtifactEvidencePart[] = [];
  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    const kind = lower.endsWith(".diff") || lower.endsWith(".patch")
      ? "diff"
      : lower.includes("test") || lower.includes("check")
        ? "test"
        : lower.endsWith(".log") || lower.endsWith(".txt") || lower.endsWith(".md")
          ? "log"
          : "file";
    parts.push({
      kind,
      label: entry.name,
      status: kind === "test" ? (runStatus === "done" ? "passed" : "failed") : runStatus === "blocked" ? "blocked" : "unknown",
      path: entry.path,
      ...(await readArtifactExcerpt(workDir, entry.path)),
    });
  }
  return parts;
}

async function readArtifactExcerpt(workDir: string, relativePath: string): Promise<Pick<ArtifactEvidencePart, "excerpt">> {
  try {
    const content = await readFile(join(workDir, relativePath), "utf8");
    const excerpt = redactAndBound(content.trim(), 600);
    return excerpt ? { excerpt } : {};
  } catch {
    return {};
  }
}

function buildArtifactManifestSummary(context: ArtifactManifestContext, evidenceCount: number): string {
  if (context.prUrl) return `Runner produced PR evidence: ${context.prUrl}`;
  const status = context.status ?? "done";
  const stream = [context.stdout, context.stderr]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (stream) return stream.slice(0, 240);
  return `Runner ${status} with ${evidenceCount} evidence part${evidenceCount === 1 ? "" : "s"}.`;
}

async function writeArtifactManifest(workDir: string, manifest: ArtifactManifest): Promise<void> {
  const path = join(workDir, "artifacts", "manifest.json");
  await mkdir(join(workDir, "artifacts"), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}


export function buildActionableError(engine: string, image: string, completed: SpawnResult): string {
  const combined = redactSecrets([completed.stderr, completed.stdout].filter(Boolean).join("\n")).trim();
  if (completed.errorCode === "ENOENT") {
    return `${engine} 실행 파일을 찾을 수 없습니다. Docker 또는 Podman을 설치하거나 A2A_DOCKER_RUNNER_ENGINE을 사용 가능한 엔진으로 설정하세요.`;
  }
  if (completed.timedOut) {
    const elapsedSec = ((completed.elapsedMs ?? 0) / 1000).toFixed(1);
    return `컨테이너 실행이 제한 시간 안에 끝나지 않았습니다 (elapsed=${elapsedSec}s). timeoutMs를 늘리거나 작업 명령을 줄이고, 남은 컨테이너가 있으면 '${engine} ps -a --filter label=a2a.task.id=<safeTaskId>'로 확인한 뒤 run별 container name을 지정해 정리하세요.\n${combined}`.trim();
  }
  const engineStderr = redactSecrets(completed.stderr).trim();
  // OOM detection: Docker/Podman kills with SIGKILL (exit 137 = 128+9) when
  // the container exceeds its memory limit.  The daemon may also emit "Out of
  // memory" to stderr.  Report resource evidence for stability gates.
  // Parent: a2a-docker-runner#227
  if (completed.code === 137 || /out of memory|OOMKill|oom-kill/i.test(engineStderr)) {
    const elapsedSec = ((completed.elapsedMs ?? 0) / 1000).toFixed(1);
    return `컨테이너가 메모리 부족(OOM)으로 종료되었습니다 (exit=137, elapsed=${elapsedSec}s). --memory 값을 늘리거나 작업 명령을 줄이세요. '${engine} inspect <container>'의 OOMKilled 필드로 확인할 수 있습니다.\n${combined}`.trim();
  }
  if (/Conflict\.? The container name|container name .* is already in use|name is already in use/i.test(engineStderr)) {
    return `컨테이너 이름 충돌이 발생했습니다. runner는 task id와 run token을 포함한 고유 이름을 사용하므로, 같은 safeTaskId를 가진 오래된 컨테이너가 남았는지 '${engine} ps -a --filter label=a2a.task.id=<safeTaskId>'로 확인하고 해당 run만 정리하세요.\n${combined}`.trim();
  }
  // Image-pull error detection: only inspect stderr for Docker/Podman engine
  // errors.  Container-side command output (stdout) must not trigger a
  // misleading image-pull summary when the container actually started.
  // Parent: a2a-docker-runner#169
  {
    if (/Error response from daemon:.*pull access denied|manifest for.*not found|no such image: |repository does not exist|unauthorized:/i.test(engineStderr)) {
      return `이미지 '${image}'를 가져오거나 찾을 수 없습니다. 이미지 이름/태그와 registry 인증을 확인하세요.\n${combined}`.trim();
    }
  }
  if (/mkdir .*permission denied|EACCES|EROFS|read-only file system|permission denied.*work/i.test(combined)) {
    return `작업 디렉터리 생성 또는 마운트 권한 문제가 감지되었습니다. rootDir 소유권/권한과 컨테이너 볼륨 마운트 정책을 확인하고, 같은 task id의 run 디렉터리가 동시에 사용 중인지 확인하세요.\n${combined}`.trim();
  }
  if (/permission denied|cannot connect to the docker daemon|got permission denied|operation not permitted|rootless/i.test(combined)) {
    return `${engine} 실행 권한 또는 daemon 연결 권한이 없습니다. runner 사용자 권한, socket 접근, rootless Podman 설정을 확인하세요.\n${combined}`.trim();
  }
  return combined || `${engine} 실행이 실패했습니다(exit=${completed.code ?? "null"}, signal=${completed.signal ?? "none"}).`;
}

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
  /** Wall-clock elapsed milliseconds from spawn to close/error. */
  elapsedMs?: number;
}

async function listArtifacts(workDir: string): Promise<string[]> {
  const dir = join(workDir, "artifacts");
  try {
    const entries = await readdir(dir);
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry);
      if ((await stat(path)).isFile()) files.push(path);
    }
    return files;
  } catch {
    return [];
  }
}

export function shouldTreatDetectedPrUrlAsCanonical(
  task: Pick<NormalizedRunnerTask, "allowNoChanges" | "readOnlyValidation">,
  stdout: string,
  stderr: string,
  detectedPrUrl: string | undefined,
): boolean {
  if (!detectedPrUrl) return false;
  const text = `${stdout}\n${stderr}`;
  if (!/(?:^|\n)(?:status=no_changes_allowed|openclaw_no_changes=allowed)\b/.test(text)) return true;
  if (/(?:^|\n)pr_created=1\b/.test(text)) return true;
  return !(task.allowNoChanges || task.readOnlyValidation);
}

export function extractPrUrl(stdout: string): string | undefined {
  // owner/repo are single path segments — using [^\s]+ for them let the match
  // greedily span two adjacent URLs and capture a wrong PR, which drives the
  // non-zero-exit -> success recovery and can flip a failed run to "completed".
  return stdout.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/)?.[0];
}
