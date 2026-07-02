#!/usr/bin/env node
import { readFileSync } from "node:fs";

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readJsonFile(path, fallback = {}) {
  if (!path) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { __readError: error instanceof Error ? error.message : String(error) };
  }
}

function payloadSourceFiles(payload) {
  const files = payload?.sourceBundle?.files;
  return Array.isArray(files) ? files.filter((file) => file && typeof file === "object") : [];
}

function filePath(file) {
  return safeText(file?.path || file?.name || file?.id, "<unnamed>");
}

function fileRepo(file) {
  return safeText(file?.repo || file?.repository, "sourceBundle");
}

function fileContent(file) {
  if (typeof file?.content === "string") return file.content;
  if (typeof file?.text === "string") return file.text;
  return "";
}

function matchesPath(file, wanted) {
  const path = filePath(file);
  const target = safeText(wanted, "");
  return path === target || path.endsWith(`/${target}`) || target.endsWith(`/${path}`);
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => safeText(item, "")).filter(Boolean) : [];
}

function projectionPolicy(payload) {
  const policy = payload?.sourceProjectionPolicy && typeof payload.sourceProjectionPolicy === "object" && !Array.isArray(payload.sourceProjectionPolicy)
    ? payload.sourceProjectionPolicy
    : {};
  return {
    requiredPaths: normalizeStringArray(policy.requiredPaths),
    minProjectedBytesPerRequiredFile: Math.max(0, Number(policy.minProjectedBytesPerRequiredFile || 0)),
  };
}

function buildSourceProjection(payload, files) {
  const policy = projectionPolicy(payload);
  const requiredFilesMissing = [];
  const requiredFilesBelowMinBytes = [];
  for (const required of policy.requiredPaths) {
    const file = files.find((candidate) => matchesPath(candidate, required));
    if (!file) {
      requiredFilesMissing.push(required);
      continue;
    }
    const bytes = Buffer.byteLength(fileContent(file), "utf8");
    if (policy.minProjectedBytesPerRequiredFile > 0 && bytes < policy.minProjectedBytesPerRequiredFile) {
      requiredFilesBelowMinBytes.push({ path: required, projectedBytes: bytes, minProjectedBytes: policy.minProjectedBytesPerRequiredFile });
    }
  }
  const canonicalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(fileContent(file), "utf8"), 0);
  const quality = files.length === 0
    ? "zero_files"
    : (requiredFilesMissing.length || requiredFilesBelowMinBytes.length ? "insufficient" : "complete");
  const budgetReason = quality === "complete"
    ? "within_budget"
    : (quality === "zero_files" ? "no_source_files" : (requiredFilesMissing.length ? "required_missing" : "required_below_min_bytes"));
  return {
    quality,
    budgetReason,
    canonicalFileCount: files.length,
    projectedFileCount: files.length,
    canonicalBytes,
    projectedBytes: canonicalBytes,
    requiredPaths: policy.requiredPaths,
    requiredFilesMissing,
    requiredFilesBelowMinBytes,
  };
}

function noLiveBoundary(payload) {
  return payload?.noLive === true || payload?.no_live === true;
}

function sourceOnlyBoundary(payload) {
  return payload?.sourceOnly === true || payload?.source_only === true;
}

function buildAnalysis({ task, payload }) {
  const files = payloadSourceFiles(payload);
  const projection = buildSourceProjection(payload, files);
  const runId = safeText(payload.runId || payload.parentRoundId || task.id, "unknown-run");
  const evidenceRefs = files.map((file) => `${fileRepo(file)}:${filePath(file)}`);
  const healthFileNames = files.map(filePath).join(", ") || "no files";
  const boundaryOk = noLiveBoundary(payload) && sourceOnlyBoundary(payload);
  const status = projection.quality === "insufficient" || projection.quality === "zero_files" || !boundaryOk ? "blocked" : "done";

  const findings = [
    `runId ${runId}`,
    `source files readable: ${healthFileNames}`,
    boundaryOk ? "no-live/source-only boundary confirmed" : "no-live/source-only boundary missing or incomplete",
    `sourceProjection quality=${projection.quality} reason=${projection.budgetReason}`,
  ];
  if (projection.requiredFilesMissing.length) {
    findings.push(`missing required source files: ${projection.requiredFilesMissing.join(", ")}`);
  }
  if (projection.requiredFilesBelowMinBytes.length) {
    findings.push(`required source files below minimum bytes: ${projection.requiredFilesBelowMinBytes.map((item) => item.path).join(", ")}`);
  }

  return {
    status,
    summary: status === "done"
      ? `source-only local bridge verified no-live evidence path for ${runId}`
      : `source-only local bridge blocked ${runId}: ${projection.budgetReason}${boundaryOk ? "" : "; missing no-live/source-only boundary"}`,
    findings,
    risks: status === "done" ? [] : ["source-only local evidence contract was not fully satisfied"],
    recommendations: [
      "Keep workertheta source-only health lanes on this deterministic local bridge unless an explicit provider-backed lane is approved.",
    ],
    evidenceRefs,
    sourceProjection: projection,
    bridgeAdapter: "source_only_local",
    requestedModel: safeText(process.env.A2A_OPENCLAW_ANALYSIS_MODEL || process.env.A2A_HERMES_ANALYSIS_MODEL || "source-only-local", "source-only-local"),
    modelInheritanceMode: "local_source_only_no_provider",
  };
}

const task = readJsonFile(process.env.A2A_ANALYSIS_TASK_FILE, {});
const payload = readJsonFile(process.env.A2A_ANALYSIS_PAYLOAD_FILE, task?.payload || {});
const analysis = buildAnalysis({ task, payload });
process.stdout.write(`${JSON.stringify({ payloads: [{ text: JSON.stringify(analysis) }] })}\n`);
