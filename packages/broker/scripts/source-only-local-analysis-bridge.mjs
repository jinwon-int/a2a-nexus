#!/usr/bin/env node
import { readFileSync } from "node:fs";

import {
  normalizeStringArray,
  payloadSourceFiles,
  sourceCarrierBytes,
  sourceCarrierContent,
  sourceCarrierPath,
  sourceCarrierRepo,
} from "./lib/source-carriers.mjs";
import { payloadWithRetrievalSnapshotSourceCarriers } from "./lib/retrieval-snapshot-carriers.mjs";

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

function matchesPath(file, wanted) {
  const path = sourceCarrierPath(file);
  const target = safeText(wanted, "");
  return path === target || path.endsWith(`/${target}`) || target.endsWith(`/${path}`);
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
    const bytes = sourceCarrierBytes(file);
    if (policy.minProjectedBytesPerRequiredFile > 0 && bytes < policy.minProjectedBytesPerRequiredFile) {
      requiredFilesBelowMinBytes.push({ path: required, projectedBytes: bytes, minProjectedBytes: policy.minProjectedBytesPerRequiredFile });
    }
  }
  const canonicalBytes = files.reduce((sum, file) => sum + sourceCarrierBytes(file), 0);
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

function buildProjectionFailureReadback(projection) {
  const quality = safeText(projection?.quality, "unknown");
  const budgetReason = safeText(projection?.budgetReason, "unknown");
  return {
    stage: "projection",
    excerpt: `stage=projection quality=${quality} budgetReason=${budgetReason} canonicalFileCount=${projection?.canonicalFileCount ?? 0} projectedFileCount=${projection?.projectedFileCount ?? 0} canonicalBytes=${projection?.canonicalBytes ?? 0} projectedBytes=${projection?.projectedBytes ?? 0}`,
  };
}

function sourceOnlyBoundary(payload) {
  return payload?.sourceOnly === true || payload?.source_only === true;
}

function buildAnalysis({ task, payload }) {
  let effectivePayload;
  try {
    effectivePayload = payloadWithRetrievalSnapshotSourceCarriers(payload).payload;
  } catch (error) {
    return {
      status: "blocked",
      summary: `source-only local bridge blocked signed retrieval snapshot payload: ${error.message}`,
      findings: [`signed retrieval snapshot validation failed: ${error.message}`],
      risks: ["signed retrieval snapshots must pass byte/hash/signature shape checks before analysis"],
      recommendations: ["Regenerate the retrieval snapshot through the docker-runner egress allowlist proxy and keep it within the analysis byte cap."],
      evidenceRefs: [],
      sourceProjection: {
        quality: "insufficient",
        budgetReason: "invalid_retrieval_snapshot",
        canonicalFileCount: 0,
        projectedFileCount: 0,
        canonicalBytes: 0,
        projectedBytes: 0,
        requiredPaths: [],
        requiredFilesMissing: [],
        requiredFilesBelowMinBytes: [],
      },
      failureReadback: { stage: "retrieval_snapshot", excerpt: error.message },
      bridgeAdapter: "source_only_local",
      requestedModel: safeText(process.env.A2A_OPENCLAW_ANALYSIS_MODEL || process.env.A2A_HERMES_ANALYSIS_MODEL || "source-only-local", "source-only-local"),
      modelInheritanceMode: "local_source_only_no_provider",
    };
  }
  const files = payloadSourceFiles(effectivePayload);
  const projection = buildSourceProjection(effectivePayload, files);
  const runId = safeText(effectivePayload.runId || effectivePayload.parentRoundId || task.id, "unknown-run");
  const evidenceRefs = files.map((file) => `${sourceCarrierRepo(file)}:${sourceCarrierPath(file)}`);
  const healthFileNames = files.map(sourceCarrierPath).join(", ") || "no files";
  const boundaryOk = noLiveBoundary(payload) && sourceOnlyBoundary(payload);
  const projectionBlocked = projection.quality === "insufficient" || projection.quality === "zero_files";
  const status = projectionBlocked || !boundaryOk ? "blocked" : "done";
  const failureReadback = projectionBlocked ? buildProjectionFailureReadback(projection) : undefined;

  const findings = [
    `runId ${runId}`,
    `source files readable: ${healthFileNames}`,
    boundaryOk ? "no-live/source-only boundary confirmed" : "no-live/source-only boundary missing or incomplete",
    `sourceProjection quality=${projection.quality} reason=${projection.budgetReason}`,
  ];
  if (files.some((file) => sourceCarrierContent(file).field === "summary")) {
    findings.push("summary content field accepted as first-class source carrier content");
  }
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
    ...(failureReadback ? { failureReadback } : {}),
    bridgeAdapter: "source_only_local",
    requestedModel: safeText(process.env.A2A_OPENCLAW_ANALYSIS_MODEL || process.env.A2A_HERMES_ANALYSIS_MODEL || "source-only-local", "source-only-local"),
    modelInheritanceMode: "local_source_only_no_provider",
  };
}

const task = readJsonFile(process.env.A2A_ANALYSIS_TASK_FILE, {});
const payload = readJsonFile(process.env.A2A_ANALYSIS_PAYLOAD_FILE, task?.payload || {});
const analysis = buildAnalysis({ task, payload });
process.stdout.write(`${JSON.stringify({ payloads: [{ text: JSON.stringify(analysis) }] })}\n`);
