#!/usr/bin/env node
import { readFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const argList = process.argv.slice(2);
const jsonMode = args.has("--json");
const inputPath = valueAfter("--input");

function valueAfter(flag) {
  const index = argList.indexOf(flag);
  return index >= 0 ? argList[index + 1] : "";
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizeSnapshot(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.workers)) return input.workers;
  if (Array.isArray(input?.nodes)) return input.nodes;
  throw new Error("input must be an array or an object with workers/nodes array");
}

function envOf(record) {
  return record?.env && typeof record.env === "object" && !Array.isArray(record.env) ? record.env : record;
}

function handlerArgsFromEnv(env) {
  const raw = safeText(env.WORKER_HANDLER_ARGS_JSON, safeText(env.A2A_WORKER_HANDLER_ARGS_JSON, ""));
  const parsed = parseJsonArray(raw);
  if (parsed.length > 0) return parsed;
  const direct = safeText(env.handlerPath, safeText(env.HANDLER_PATH, ""));
  return direct ? [direct] : [];
}

function classify(record) {
  const env = envOf(record);
  const nodeId = safeText(record.nodeId, safeText(record.id, safeText(env.WORKER_ID, safeText(env.A2A_NODE_ID, "unknown"))));
  const service = safeText(record.service, safeText(env.SERVICE_NAME, "unknown"));
  const profile = safeText(env.A2A_WORKER_PROFILE, safeText(env.WORKER_PROFILE, ""));
  const runtimeFlavor = safeText(record.runtimeFlavor, safeText(env.A2A_WORKER_RUNTIME_FLAVOR, safeText(env.WORKER_RUNTIME_FLAVOR, "")));
  const handlerArgs = handlerArgsFromEnv(env);
  const joinedArgs = handlerArgs.join(" ");
  const canonicalHandler = /(^|\/)a2a-task-handler\.mjs$/.test(joinedArgs) && !/openclaw-a2a-task-handler\.mjs/.test(joinedArgs);
  const legacyHandler = /openclaw-a2a-task-handler\.mjs/.test(joinedArgs);
  const canonicalProfile = profile === "broker-poll-only";
  const legacyProfile = profile === "openclaw-poll-only";
  const profileUnset = profile === "";
  const findings = [];
  const blockers = [];

  if (legacyHandler) blockers.push("legacy handler path openclaw-a2a-task-handler.mjs is still referenced");
  if (legacyProfile) blockers.push("legacy profile openclaw-poll-only is still referenced");
  if (!canonicalHandler) findings.push("canonical handler path scripts/a2a-task-handler.mjs was not observed");
  if (!canonicalProfile && !profileUnset) findings.push(`non-canonical worker profile observed: ${profile}`);
  if (profileUnset && runtimeFlavor && !/hermes|broker-poll-http-handler/.test(runtimeFlavor)) {
    findings.push(`profile unset with non-neutral runtime flavor: ${runtimeFlavor}`);
  }

  const status = blockers.length > 0 ? "legacy-blocked" : (canonicalHandler && (canonicalProfile || profileUnset) ? "canonical" : "needs-review");
  return { nodeId, service, profile: profile || "(unset)", runtimeFlavor: runtimeFlavor || "(unset)", handlerArgs, canonicalHandler, legacyHandler, canonicalProfile, legacyProfile, status, findings, blockers };
}

function summarize(results) {
  return {
    total: results.length,
    canonical: results.filter((item) => item.status === "canonical").length,
    needsReview: results.filter((item) => item.status === "needs-review").length,
    legacyBlocked: results.filter((item) => item.status === "legacy-blocked").length,
    removalSafe: results.length > 0 && results.every((item) => item.status === "canonical"),
  };
}

function renderHuman(report) {
  const lines = [];
  lines.push("# Worker compatibility audit");
  lines.push("");
  lines.push(`total=${report.summary.total} canonical=${report.summary.canonical} needsReview=${report.summary.needsReview} legacyBlocked=${report.summary.legacyBlocked} removalSafe=${report.summary.removalSafe}`);
  for (const item of report.results) {
    lines.push("");
    lines.push(`## ${item.nodeId}`);
    lines.push(`- status: ${item.status}`);
    lines.push(`- service: ${item.service}`);
    lines.push(`- profile: ${item.profile}`);
    lines.push(`- runtimeFlavor: ${item.runtimeFlavor}`);
    lines.push(`- handlerArgs: ${item.handlerArgs.length ? item.handlerArgs.join(" ") : "(missing)"}`);
    if (item.blockers.length) lines.push(`- blockers: ${item.blockers.join("; ")}`);
    if (item.findings.length) lines.push(`- findings: ${item.findings.join("; ")}`);
  }
  return lines.join("\n");
}

const raw = inputPath ? readFileSync(inputPath, "utf8") : readStdin();
const input = JSON.parse(raw || "[]");
const results = normalizeSnapshot(input).map(classify);
const report = { summary: summarize(results), results };
if (jsonMode) console.log(JSON.stringify(report, null, 2));
else console.log(renderHuman(report));
